USE Car_ServiceDB;

-- 1. Add Service_Type to Service_Request (if not already present)
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'Service_Request' AND COLUMN_NAME = 'Service_Type'
)
BEGIN
    ALTER TABLE Service_Request
        ADD Service_Type NVARCHAR(50) NOT NULL DEFAULT 'Specific';
    PRINT 'Service_Type column added to Service_Request ✅';
END
ELSE
    PRINT 'Service_Type already exists — skipped';

-- 2. Add Labor_Charge to Mechanic (if not already present)
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'Mechanic' AND COLUMN_NAME = 'Labor_Charge'
)
BEGIN
    ALTER TABLE Mechanic
        ADD Labor_Charge DECIMAL(10,2) NOT NULL DEFAULT 500;
    PRINT 'Labor_Charge column added to Mechanic ✅';
END
ELSE
    PRINT 'Labor_Charge already exists — skipped';

-- Verify
SELECT COLUMN_NAME, DATA_TYPE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME IN ('Service_Request', 'Mechanic')
  AND COLUMN_NAME IN ('Service_Type', 'Labor_Charge');