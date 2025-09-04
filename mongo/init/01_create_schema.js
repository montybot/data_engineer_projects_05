const dbName = process.env.MONGO_DBNAME || "medical";
const db = db.getSiblingDB(dbName);

db.createCollection("admissions", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["admission_id", "patient", "date_of_admission", "hospital"],
      properties: {
        admission_id: { bsonType: "string" },
        patient: {
          bsonType: "object",
          required: ["name", "age", "gender"],
          properties: {
            name: {
              bsonType: "object",
              required: ["full"],
              properties: {
                full: { bsonType: "string" },
                given: { bsonType: "string" },
                family: { bsonType: "string" }
              }
            },
            age: { bsonType: "int", minimum: 0, maximum: 130 },
            gender: { enum: ["male", "female"] },
            blood_type: { bsonType: "string" }
          }
        },
        medical_condition: { bsonType: "string" },
        date_of_admission: { bsonType: "date" },
        discharge_date: { bsonType: ["date", "null"] },
        admission_duration_days: { bsonType: ["int", "null"] },
        admission_type: { enum: ["Emergency", "Elective", "Urgent", null] },
        doctor: { bsonType: "string" },
        hospital: { bsonType: "string" },
        room_number: { bsonType: "string" },
        insurance: {
          bsonType: "object",
          properties: {
            provider: {
              enum: ["Aetna", "Blue Cross", "Cigna", "UnitedHealthcare", "Medicare", "Other", null]
            }
          }
        },
        billing_amount: { bsonType: ["double", "int"] },
        medication: { bsonType: "string" },
        test_results: { enum: ["Normal", "Abnormal", "Inconclusive", null] },
        created_at: { bsonType: "date" },
        updated_at: { bsonType: "date" }
      }
    }
  },
  validationLevel: "moderate"
});

// Index
db.admissions.createIndex({ admission_id: 1 }, { unique: true });
db.admissions.createIndex({ "patient.name.full": 1, date_of_admission: -1 });
db.admissions.createIndex({ hospital: 1, date_of_admission: -1 });
db.admissions.createIndex({ doctor: 1, date_of_admission: -1 });
