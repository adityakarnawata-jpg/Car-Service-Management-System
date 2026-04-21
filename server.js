const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// ✅ Serve frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═════════════════════════════════════════════
// ⚠  SQL MIGRATIONS — Run once in SSMS before starting server
// ─────────────────────────────────────────────
// ALTER TABLE Service_Request
//     ADD Service_Type NVARCHAR(50) NOT NULL DEFAULT 'Specific';
//
// ALTER TABLE Mechanic
//     ADD Labor_Charge DECIMAL(10,2) NOT NULL DEFAULT 500;
//
// FREE SERVICE LIMIT = 2 per car (enforced in server logic)
// ═════════════════════════════════════════════

// ─────────────────────────────────────────────
// SQL Server Config  — SQL Server Authentication
// ─────────────────────────────────────────────
const config = {
    server: 'localhost',
    port:   59502,
    database: 'Car_ServiceDB',
    user:     'sa',
    password: 'AutoServ123!',
    options: {
        trustServerCertificate: true,
        encrypt: false
    },
    requestTimeout:    60000,
    connectionTimeout: 30000,
    pool: {
        max: 10,
        min: 2,
        idleTimeoutMillis: 30000
    }
};

let pool;
async function getPool() {
    if (!pool || !pool.connected) {
        pool = await sql.connect(config);
    }
    return pool;
}

getPool()
    .then(() => console.log('✅ Connected to SQL Server'))
    .catch(err => console.error('❌ DB Error:', err.message));

// ─────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────
function handleError(res, err) {
    console.error('Route Error:', err.message);
    res.status(500).json({ error: err.message });
}

// ─────────────────────────────────────────────
// TEST
// ─────────────────────────────────────────────
app.get('/api/test', (req, res) => {
    res.json({ message: 'API Working ✅' });
});

// ═════════════════════════════════════════════
// STATS  —  GET /api/stats
// ═════════════════════════════════════════════
app.get('/api/stats', async (req, res) => {
    try {
        const p = await getPool();
        const [custResult, carResult, svcResult, revResult] = await Promise.all([
            p.request().query(`SELECT COUNT(*) AS cnt FROM Customer`),
            p.request().query(`SELECT COUNT(*) AS cnt FROM Car`),
            p.request().query(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN Service_status = 'Completed'  THEN 1 ELSE 0 END) AS completed,
                    SUM(CASE WHEN Service_status = 'In Progress' THEN 1 ELSE 0 END) AS inprogress,
                    SUM(CASE WHEN Service_status = 'Pending'    THEN 1 ELSE 0 END) AS pending
                FROM Service_Request`),
            p.request().query(`SELECT ISNULL(SUM(Total_Amount), 0) AS revenue FROM Bill`)
        ]);
        res.json({
            customers: custResult.recordset[0].cnt,
            cars:      carResult.recordset[0].cnt,
            services:  svcResult.recordset[0],
            revenue:   revResult.recordset[0].revenue
        });
    } catch (err) { handleError(res, err); }
});

// ═════════════════════════════════════════════
// CUSTOMERS
// ═════════════════════════════════════════════
app.get('/api/customers', async (req, res) => {
    const fetchAll = req.query.limit === 'all';
    const limit    = fetchAll ? null : Math.min(parseInt(req.query.limit) || 100, 500);
    const offset   = fetchAll ? 0    : (parseInt(req.query.page) || 0) * limit;
    try {
        const p = await getPool();
        const query = fetchAll
            ? `SELECT c.C_id, c.C_name, c.Phone, c.Email, c.Address,
                   COUNT(car.Car_id) AS car_count
               FROM Customer c
               LEFT JOIN Car car ON car.C_id = c.C_id
               GROUP BY c.C_id, c.C_name, c.Phone, c.Email, c.Address
               ORDER BY c.C_id DESC`
            : `SELECT c.C_id, c.C_name, c.Phone, c.Email, c.Address,
                   COUNT(car.Car_id) AS car_count
               FROM Customer c
               LEFT JOIN Car car ON car.C_id = c.C_id
               GROUP BY c.C_id, c.C_name, c.Phone, c.Email, c.Address
               ORDER BY c.C_id DESC
               OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
        const req2 = p.request();
        if (!fetchAll) {
            req2.input('limit',  sql.Int, limit);
            req2.input('offset', sql.Int, offset);
        }
        const result = await req2.query(query);
        res.json(result.recordset);
    } catch (err) { handleError(res, err); }
});

app.post('/api/customers', async (req, res) => {
    const { name, phone, email, address } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and Phone are required' });
    try {
        const p = await getPool();
        const result = await p.request()
            .input('name',    sql.NVarChar(100), name)
            .input('phone',   sql.VarChar(15),   phone)
            .input('email',   sql.NVarChar(100), email   || null)
            .input('address', sql.NVarChar(200), address || null)
            .query(`
                INSERT INTO Customer (C_name, Phone, Email, Address)
                OUTPUT INSERTED.C_id
                VALUES (@name, @phone, @email, @address)`);
        res.status(201).json({ C_id: result.recordset[0].C_id });
    } catch (err) { handleError(res, err); }
});

app.delete('/api/customers/:id', async (req, res) => {
    try {
        const p = await getPool();
        await p.request()
            .input('id', sql.Int, req.params.id)
            .query(`DELETE FROM Customer WHERE C_id = @id`);
        res.json({ success: true });
    } catch (err) { handleError(res, err); }
});

// ═════════════════════════════════════════════
// CARS
// ═════════════════════════════════════════════
app.get('/api/cars', async (req, res) => {
    const fetchAll = req.query.limit === 'all';
    const limit    = fetchAll ? null : Math.min(parseInt(req.query.limit) || 100, 500);
    const offset   = fetchAll ? 0    : (parseInt(req.query.page) || 0) * limit;
    try {
        const p = await getPool();
        const query = fetchAll
            ? `SELECT car.Car_id, car.Registration_number, car.Brand, car.Model, car.Manu_Year,
                   car.C_id, c.C_name AS owner_name
               FROM Car car
               LEFT JOIN Customer c ON c.C_id = car.C_id
               ORDER BY car.Car_id DESC`
            : `SELECT car.Car_id, car.Registration_number, car.Brand, car.Model, car.Manu_Year,
                   car.C_id, c.C_name AS owner_name
               FROM Car car
               LEFT JOIN Customer c ON c.C_id = car.C_id
               ORDER BY car.Car_id DESC
               OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
        const req2 = p.request();
        if (!fetchAll) {
            req2.input('limit',  sql.Int, limit);
            req2.input('offset', sql.Int, offset);
        }
        const result = await req2.query(query);
        res.json(result.recordset);
    } catch (err) { handleError(res, err); }
});

app.post('/api/cars', async (req, res) => {
    const { reg, brand, model, year, cid } = req.body;
    if (!reg || !brand || !model || !year || !cid)
        return res.status(400).json({ error: 'All fields required' });
    try {
        const p = await getPool();
        const result = await p.request()
            .input('reg',   sql.VarChar(20),  reg)
            .input('brand', sql.NVarChar(50), brand)
            .input('model', sql.NVarChar(50), model)
            .input('year',  sql.Int,          parseInt(year))
            .input('cid',   sql.Int,          parseInt(cid))
            .query(`
                INSERT INTO Car (Registration_number, Brand, Model, Manu_Year, C_id)
                OUTPUT INSERTED.Car_id
                VALUES (@reg, @brand, @model, @year, @cid)`);
        res.status(201).json({ Car_id: result.recordset[0].Car_id });
    } catch (err) { handleError(res, err); }
});

app.delete('/api/cars/:id', async (req, res) => {
    try {
        const p = await getPool();
        await p.request()
            .input('id', sql.Int, req.params.id)
            .query(`DELETE FROM Car WHERE Car_id = @id`);
        res.json({ success: true });
    } catch (err) { handleError(res, err); }
});

// ─────────────────────────────────────────────
// ★ NEW — Car Free Service Eligibility
//   GET /api/cars/:id/service-eligibility
//   Returns how many free services a car has used and whether next is free
// ─────────────────────────────────────────────
app.get('/api/cars/:id/service-eligibility', async (req, res) => {
    const carId = parseInt(req.params.id);
    if (isNaN(carId)) return res.status(400).json({ error: 'Invalid car ID' });
    const FREE_LIMIT = 2;
    try {
        const p = await getPool();
        const result = await p.request()
            .input('carId', sql.Int, carId)
            .query(`SELECT COUNT(*) AS total FROM Service_Request WHERE Car_id = @carId`);
        const total = result.recordset[0].total;
        res.json({
            totalServices:  total,
            freeUsed:       Math.min(total, FREE_LIMIT),
            freeLimit:      FREE_LIMIT,
            isFree:         total < FREE_LIMIT,
            remainingFree:  Math.max(0, FREE_LIMIT - total)
        });
    } catch (err) { handleError(res, err); }
});

// ═════════════════════════════════════════════
// MECHANICS
// ═════════════════════════════════════════════
app.get('/api/mechanics', async (req, res) => {
    try {
        const p = await getPool();
        const result = await p.request().query(`
            SELECT m.M_id, m.MName, m.Phone, m.Specialization,
                ISNULL(m.Labor_Charge, 500) AS Labor_Charge,
                COUNT(sr.Service_id) AS job_count
            FROM Mechanic m
            LEFT JOIN Service_Request sr ON sr.M_id = m.M_id
            GROUP BY m.M_id, m.MName, m.Phone, m.Specialization, m.Labor_Charge
            ORDER BY m.M_id DESC`);
        res.json(result.recordset);
    } catch (err) { handleError(res, err); }
});

app.post('/api/mechanics', async (req, res) => {
    const { name, phone, spec, laborCharge } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and Phone are required' });
    try {
        const p = await getPool();
        const result = await p.request()
            .input('name',        sql.NVarChar(100), name)
            .input('phone',       sql.VarChar(15),   phone)
            .input('spec',        sql.NVarChar(100), spec || null)
            .input('laborCharge', sql.Decimal(10,2), laborCharge ? parseFloat(laborCharge) : 500)
            .query(`
                INSERT INTO Mechanic (MName, Phone, Specialization, Labor_Charge)
                OUTPUT INSERTED.M_id
                VALUES (@name, @phone, @spec, @laborCharge)`);
        res.status(201).json({ M_id: result.recordset[0].M_id });
    } catch (err) { handleError(res, err); }
});

app.delete('/api/mechanics/:id', async (req, res) => {
    try {
        const p = await getPool();
        await p.request()
            .input('id', sql.Int, req.params.id)
            .query(`DELETE FROM Mechanic WHERE M_id = @id`);
        res.json({ success: true });
    } catch (err) { handleError(res, err); }
});

// ═════════════════════════════════════════════
// SERVICE REQUESTS
// ═════════════════════════════════════════════
app.get('/api/services', async (req, res) => {
    const fetchAll = req.query.limit === 'all';
    const limit  = fetchAll ? 99999 : Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = fetchAll ? 0 : (parseInt(req.query.page) || 0) * limit;
    try {
        const p = await getPool();
        const result = await p.request()
            .input('limit',  sql.Int, limit)
            .input('offset', sql.Int, offset)
            .query(`
                SELECT sr.Service_id, sr.Service_date, sr.Problem,
                    sr.Service_status, sr.Service_Type,
                    car.Car_id, car.Registration_number, car.Brand, car.Model,
                    c.C_id, c.C_name, c.Phone,
                    m.M_id, m.MName
                FROM Service_Request sr
                LEFT JOIN Car      car ON car.Car_id = sr.Car_id
                LEFT JOIN Customer c   ON c.C_id     = car.C_id
                LEFT JOIN Mechanic m   ON m.M_id      = sr.M_id
                ORDER BY sr.Service_id DESC
                OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`);
        res.json(result.recordset);
    } catch (err) { handleError(res, err); }
});

// ★ MODIFIED — now accepts serviceType
app.post('/api/services', async (req, res) => {
    const { date, problem, status, carId, mId, serviceType } = req.body;
    if (!date || !carId) return res.status(400).json({ error: 'Date and Car are required' });
    try {
        const p = await getPool();
        const result = await p.request()
            .input('date',        sql.Date,          date)
            .input('problem',     sql.NVarChar(500),  problem     || null)
            .input('status',      sql.NVarChar(20),   status      || 'Pending')
            .input('carId',       sql.Int,            parseInt(carId))
            .input('mId',         sql.Int,            mId ? parseInt(mId) : null)
            .input('serviceType', sql.NVarChar(50),   serviceType || 'Specific')
            .query(`
                INSERT INTO Service_Request
                    (Service_date, Problem, Service_status, Car_id, M_id, Service_Type)
                OUTPUT INSERTED.Service_id
                VALUES (@date, @problem, @status, @carId, @mId, @serviceType)`);
        res.status(201).json({ Service_id: result.recordset[0].Service_id });
    } catch (err) { handleError(res, err); }
});

app.patch('/api/services/:id/status', async (req, res) => {
    const { status } = req.body;
    const valid = ['Pending', 'In Progress', 'Completed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    try {
        const p = await getPool();
        await p.request()
            .input('id',     sql.Int,         req.params.id)
            .input('status', sql.NVarChar(20), status)
            .query(`UPDATE Service_Request SET Service_status = @status WHERE Service_id = @id`);
        res.json({ success: true });
    } catch (err) { handleError(res, err); }
});

app.delete('/api/services/:id', async (req, res) => {
    try {
        const p = await getPool();
        await p.request()
            .input('id', sql.Int, req.params.id)
            .query(`DELETE FROM Service_Request WHERE Service_id = @id`);
        res.json({ success: true });
    } catch (err) { handleError(res, err); }
});

app.get('/api/services/:id/parts', async (req, res) => {
    try {
        const p = await getPool();
        const result = await p.request()
            .input('id', sql.Int, req.params.id)
            .query(`
                SELECT sp.Part_id, sp.PName, sp.Price, u.Quantity
                FROM Uses u
                JOIN Spare_Part sp ON sp.Part_id = u.Part_id
                WHERE u.Service_id = @id`);
        res.json(result.recordset);
    } catch (err) { handleError(res, err); }
});

// ─────────────────────────────────────────────
// ★ NEW — Auto-calculate bill for a completed service
//   GET /api/services/:id/calculate-amount
//   Returns: { isFree, parts[], partsTotal, laborCharge, total, serviceType }
//
//   FREE SERVICE RULE:
//     Count services booked for same car BEFORE this one (Service_id < @sid).
//     If prior count < 2  →  this service is FREE (total = 0)
//     If prior count >= 2 →  charge parts + mechanic Labor_Charge
// ─────────────────────────────────────────────
app.get('/api/services/:id/calculate-amount', async (req, res) => {
    const sid = parseInt(req.params.id);
    if (isNaN(sid)) return res.status(400).json({ error: 'Invalid service ID' });
    const FREE_LIMIT = 2;
    try {
        const p = await getPool();

        // 1. Get service meta: car, type, mechanic labor charge
        const svcRes = await p.request()
            .input('id', sql.Int, sid)
            .query(`
                SELECT
                    sr.Car_id,
                    sr.Service_Type,
                    ISNULL(m.Labor_Charge, 500) AS Labor_Charge
                FROM Service_Request sr
                LEFT JOIN Mechanic m ON m.M_id = sr.M_id
                WHERE sr.Service_id = @id`);

        if (!svcRes.recordset.length)
            return res.status(404).json({ error: 'Service not found' });

        const { Car_id, Service_Type, Labor_Charge } = svcRes.recordset[0];

        // 2. Count how many services this car had BEFORE this one (free-service check)
        const priorRes = await p.request()
            .input('carId', sql.Int, Car_id)
            .input('sid',   sql.Int, sid)
            .query(`
                SELECT COUNT(*) AS cnt
                FROM Service_Request
                WHERE Car_id = @carId AND Service_id < @sid`);

        const priorCount = priorRes.recordset[0].cnt;
        const isFree     = priorCount < FREE_LIMIT;

        // 3. Get parts breakdown
        const partsRes = await p.request()
            .input('id', sql.Int, sid)
            .query(`
                SELECT
                    sp.PName,
                    CAST(sp.Price     AS DECIMAL(10,2)) AS Price,
                    u.Quantity,
                    CAST(sp.Price * u.Quantity AS DECIMAL(10,2)) AS line_total
                FROM Uses u
                JOIN Spare_Part sp ON sp.Part_id = u.Part_id
                WHERE u.Service_id = @id`);

        const parts      = partsRes.recordset;
        const partsTotal = parts.reduce((s, x) => s + Number(x.line_total), 0);
        const labor      = isFree ? 0 : Number(Labor_Charge);
        const total      = isFree ? 0 : parseFloat((partsTotal + labor).toFixed(2));

        res.json({
            isFree,
            priorServices: priorCount,
            freeLimit:     FREE_LIMIT,
            serviceType:   Service_Type || 'Specific',
            parts,
            partsTotal:    parseFloat(partsTotal.toFixed(2)),
            laborCharge:   parseFloat(labor.toFixed(2)),
            total
        });
    } catch (err) { handleError(res, err); }
});

// ═════════════════════════════════════════════
// SPARE PARTS
// ═════════════════════════════════════════════
app.get('/api/parts', async (req, res) => {
    try {
        const p = await getPool();
        const result = await p.request().query(`
            SELECT Part_id, PName, Price, Stock FROM Spare_Part ORDER BY Part_id DESC`);
        res.json(result.recordset);
    } catch (err) { handleError(res, err); }
});

app.post('/api/parts', async (req, res) => {
    const { name, price, stock } = req.body;
    if (!name || price === undefined || stock === undefined)
        return res.status(400).json({ error: 'All fields required' });
    try {
        const p = await getPool();
        const result = await p.request()
            .input('name',  sql.NVarChar(100), name)
            .input('price', sql.Decimal(10,2), parseFloat(price))
            .input('stock', sql.Int,           parseInt(stock))
            .query(`
                INSERT INTO Spare_Part (PName, Price, Stock)
                OUTPUT INSERTED.Part_id
                VALUES (@name, @price, @stock)`);
        res.status(201).json({ Part_id: result.recordset[0].Part_id });
    } catch (err) { handleError(res, err); }
});

app.patch('/api/parts/:id/restock', async (req, res) => {
    const { qty } = req.body;
    if (!qty || qty <= 0) return res.status(400).json({ error: 'Qty must be > 0' });
    try {
        const p = await getPool();
        await p.request()
            .input('id',  sql.Int, req.params.id)
            .input('qty', sql.Int, parseInt(qty))
            .query(`UPDATE Spare_Part SET Stock = Stock + @qty WHERE Part_id = @id`);
        res.json({ success: true });
    } catch (err) { handleError(res, err); }
});

app.delete('/api/parts/:id', async (req, res) => {
    try {
        const p = await getPool();
        await p.request()
            .input('id', sql.Int, req.params.id)
            .query(`DELETE FROM Spare_Part WHERE Part_id = @id`);
        res.json({ success: true });
    } catch (err) { handleError(res, err); }
});

// ═════════════════════════════════════════════
// BILLING
// ═════════════════════════════════════════════
app.get('/api/bills', async (req, res) => {
    const fetchAll = req.query.limit === 'all';
    const limit  = fetchAll ? 99999 : Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = fetchAll ? 0 : (parseInt(req.query.page) || 0) * limit;
    try {
        const p = await getPool();
        const result = await p.request()
            .input('limit',  sql.Int, limit)
            .input('offset', sql.Int, offset)
            .query(`
                SELECT b.Bill_id, b.Bill_date, b.Total_Amount, b.Payment_Mode, b.Service_id,
                    sr.Problem, sr.Service_Type,
                    car.Registration_number, car.Brand, car.Model,
                    c.C_name, c.Phone, m.MName
                FROM Bill b
                LEFT JOIN Service_Request sr ON sr.Service_id = b.Service_id
                LEFT JOIN Car              car ON car.Car_id    = sr.Car_id
                LEFT JOIN Customer         c   ON c.C_id        = car.C_id
                LEFT JOIN Mechanic         m   ON m.M_id         = sr.M_id
                ORDER BY b.Bill_id DESC
                OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`);
        res.json(result.recordset);
    } catch (err) { handleError(res, err); }
});

// ★ MODIFIED — amount is now auto-calculated if not provided
app.post('/api/bills', async (req, res) => {
    const { date, mode, serviceId, amount } = req.body;
    if (!date || !mode || !serviceId)
        return res.status(400).json({ error: 'Date, mode, and serviceId are required' });

    let finalAmount = amount !== undefined ? parseFloat(amount) : null;

    // If amount not provided, auto-calculate from parts + mechanic labor
    if (finalAmount === null || isNaN(finalAmount)) {
        try {
            const p2 = await getPool();
            const calcRes = await p2.request()
                .input('id', sql.Int, parseInt(serviceId))
                .query(`
                    SELECT
                        ISNULL(SUM(u.Quantity * sp.Price), 0)          AS parts_total,
                        ISNULL(m.Labor_Charge, 500)                    AS labor_charge,
                        sr.Car_id
                    FROM Service_Request sr
                    LEFT JOIN Uses        u  ON u.Service_id  = sr.Service_id
                    LEFT JOIN Spare_Part  sp ON sp.Part_id    = u.Part_id
                    LEFT JOIN Mechanic    m  ON m.M_id         = sr.M_id
                    WHERE sr.Service_id = @id
                    GROUP BY sr.Car_id, m.Labor_Charge`);

            if (calcRes.recordset.length) {
                const { parts_total, labor_charge, Car_id } = calcRes.recordset[0];
                // Check free service eligibility
                const priorRes = await p2.request()
                    .input('carId', sql.Int, Car_id)
                    .input('sid',   sql.Int, parseInt(serviceId))
                    .query(`SELECT COUNT(*) AS cnt FROM Service_Request WHERE Car_id=@carId AND Service_id<@sid`);
                const isFree = priorRes.recordset[0].cnt < 2;
                finalAmount = isFree ? 0 : parseFloat((Number(parts_total) + Number(labor_charge)).toFixed(2));
            } else {
                finalAmount = 0;
            }
        } catch (_) { finalAmount = 0; }
    }

    try {
        const p = await getPool();
        const result = await p.request()
            .input('date',      sql.Date,         date)
            .input('mode',      sql.NVarChar(20),  mode)
            .input('serviceId', sql.Int,           parseInt(serviceId))
            .input('amount',    sql.Decimal(10,2), finalAmount)
            .query(`
                INSERT INTO Bill (Bill_date, Total_Amount, Payment_Mode, Service_id)
                OUTPUT INSERTED.Bill_id
                VALUES (@date, @amount, @mode, @serviceId)`);
        res.status(201).json({ Bill_id: result.recordset[0].Bill_id, Total_Amount: finalAmount });
    } catch (err) { handleError(res, err); }
});

app.delete('/api/bills/:id', async (req, res) => {
    try {
        const p = await getPool();
        await p.request()
            .input('id', sql.Int, req.params.id)
            .query(`DELETE FROM Bill WHERE Bill_id = @id`);
        res.json({ success: true });
    } catch (err) { handleError(res, err); }
});

// ═════════════════════════════════════════════
// ★  CUSTOMER PORTAL ENDPOINTS
// ═════════════════════════════════════════════

// POST /api/customer/login
app.post('/api/customer/login', async (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone)
        return res.status(400).json({ error: 'Name and phone are required' });
    try {
        const p = await getPool();
        const result = await p.request()
            .input('name',  sql.NVarChar(100), name.trim())
            .input('phone', sql.VarChar(15),   phone.trim())
            .query(`
                SELECT C_id, C_name, Phone, Email, Address
                FROM Customer
                WHERE C_name = @name AND Phone = @phone`);
        if (!result.recordset.length)
            return res.status(404).json({ error: 'Customer not found' });
        res.json(result.recordset[0]);
    } catch (err) { handleError(res, err); }
});

// POST /api/customer/auto-mechanic
app.post('/api/customer/auto-mechanic', async (req, res) => {
    const { problem } = req.body;

    const specMap = {
        'engine':'Engine Repair','oil':'Engine Repair','piston':'Engine Repair',
        'smoke':'Engine Repair','stall':'Engine Repair','misfire':'Engine Repair',
        'half service':'Engine Repair',
        'ac':'AC & Cooling','air condition':'AC & Cooling','cooling':'AC & Cooling',
        'radiator':'AC & Cooling','overheat':'AC & Cooling','heat':'AC & Cooling','coolant':'AC & Cooling',
        'electrical':'Electrical Systems','battery':'Electrical Systems','light':'Electrical Systems',
        'wiring':'Electrical Systems','horn':'Electrical Systems','fuse':'Electrical Systems',
        'short circuit':'Electrical Systems','sensor':'Electrical Systems',
        'body':'Body & Paint','paint':'Body & Paint','dent':'Body & Paint',
        'scratch':'Body & Paint','rust':'Body & Paint','bumper':'Body & Paint','door':'Body & Paint',
        'transmission':'Transmission','gear':'Transmission','clutch':'Transmission',
        'gearbox':'Transmission','shift':'Transmission',
        'brake':'Brake & Suspension','suspension':'Brake & Suspension',
        'steering':'Brake & Suspension','exhaust':'Brake & Suspension',
        'full service':'Brake & Suspension',
    };

    const lower = (problem || '').toLowerCase();
    let targetSpec = null;
    for (const [keyword, spec] of Object.entries(specMap)) {
        if (lower.includes(keyword)) { targetSpec = spec; break; }
    }

    try {
        const p = await getPool();
        let result;
        if (targetSpec) {
            result = await p.request()
                .input('spec', sql.NVarChar(100), targetSpec)
                .query(`
                    SELECT TOP 1
                        m.M_id, m.MName, m.Specialization, m.Phone,
                        ISNULL(m.Labor_Charge, 500) AS Labor_Charge,
                        COUNT(sr.Service_id) AS active_jobs
                    FROM Mechanic m
                    LEFT JOIN Service_Request sr
                        ON sr.M_id = m.M_id AND sr.Service_status != 'Completed'
                    WHERE m.Specialization = @spec
                    GROUP BY m.M_id, m.MName, m.Specialization, m.Phone, m.Labor_Charge
                    ORDER BY active_jobs ASC`);
        }
        if (!result || !result.recordset.length) {
            result = await p.request().query(`
                SELECT TOP 1
                    m.M_id, m.MName, m.Specialization, m.Phone,
                    ISNULL(m.Labor_Charge, 500) AS Labor_Charge,
                    COUNT(sr.Service_id) AS active_jobs
                FROM Mechanic m
                LEFT JOIN Service_Request sr
                    ON sr.M_id = m.M_id AND sr.Service_status != 'Completed'
                GROUP BY m.M_id, m.MName, m.Specialization, m.Phone, m.Labor_Charge
                ORDER BY active_jobs ASC`);
        }
        if (!result.recordset.length)
            return res.status(404).json({ error: 'No mechanics available' });
        res.json({ ...result.recordset[0], matched: !!targetSpec, matched_spec: targetSpec });
    } catch (err) { handleError(res, err); }
});

// GET /api/customer/:id/dashboard
// ★ MODIFIED — cars now include service_count for free-service badge display
app.get('/api/customer/:id/dashboard', async (req, res) => {
    const cid = parseInt(req.params.id);
    if (isNaN(cid)) return res.status(400).json({ error: 'Invalid customer ID' });
    try {
        const p = await getPool();
        const [carsR, svcsR, billsR] = await Promise.all([
            // Cars with service count for free-service badge
            p.request()
                .input('cid', sql.Int, cid)
                .query(`
                    SELECT
                        car.Car_id, car.Registration_number, car.Brand, car.Model, car.Manu_Year,
                        COUNT(sr.Service_id) AS service_count
                    FROM Car car
                    LEFT JOIN Service_Request sr ON sr.Car_id = car.Car_id
                    WHERE car.C_id = @cid
                    GROUP BY car.Car_id, car.Registration_number, car.Brand, car.Model, car.Manu_Year
                    ORDER BY car.Car_id DESC`),

            // Service requests with Service_Type
            p.request()
                .input('cid', sql.Int, cid)
                .query(`
                    SELECT
                        sr.Service_id, sr.Service_date, sr.Problem,
                        sr.Service_status, sr.Service_Type,
                        car.Car_id, car.Registration_number, car.Brand, car.Model,
                        m.M_id, m.MName, m.Specialization, m.Phone AS M_phone
                    FROM Service_Request sr
                    JOIN Car car ON car.Car_id = sr.Car_id
                    LEFT JOIN Mechanic m ON m.M_id = sr.M_id
                    WHERE car.C_id = @cid
                    ORDER BY sr.Service_id DESC`),

            // Bills
            p.request()
                .input('cid', sql.Int, cid)
                .query(`
                    SELECT
                        b.Bill_id, b.Bill_date, b.Total_Amount, b.Payment_Mode, b.Service_id,
                        car.Car_id, car.Registration_number, car.Brand, car.Model,
                        sr.Problem, sr.Service_status, sr.Service_Type,
                        m.MName
                    FROM Bill b
                    JOIN Service_Request sr ON sr.Service_id = b.Service_id
                    JOIN Car car            ON car.Car_id    = sr.Car_id
                    LEFT JOIN Mechanic m    ON m.M_id        = sr.M_id
                    WHERE car.C_id = @cid
                    ORDER BY b.Bill_id DESC`)
        ]);
        res.json({
            cars:     carsR.recordset,
            services: svcsR.recordset,
            bills:    billsR.recordset
        });
    } catch (err) { handleError(res, err); }
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`🚀 Customer portal at http://localhost:${PORT}/customer.html`);
});