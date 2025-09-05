/**
 * Usage rapide (depuis la racine du projet) :
 *   docker exec -i mongo mongosh \
 *     -u $MONGO_INITDB_ROOT_USERNAME -p $MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase admin \
 *     < tools/dashboard_analytics.js
 *
 * Par défaut : DB=medical, COLL=admissions. Modifie les filtres ci-dessous si besoin.
 */

const DB_NAME = "medical";
const COLL = "admissions";

/* ===========================
 * Filtres optionnels (mets null pour ignorer)
 * =========================== */
const FILTERS = {
  year: null,                 // ex: 2023
  month: null,                // 1..12
  medical_condition: null,    // ex: "Diabetes"
  insurance_provider: null,   // ex: "Aetna"
  test_results: null,         // "Normal" | "Abnormal" | "Inconclusive"
  blood_type: null,           // ex: "A+"
  gender: null                // "male" | "female"
};

/* ===========================
 * Helpers d'affichage
 * =========================== */
function hr(title) {
  print("\n============================================================");
  if (title) print(title);
  print("============================================================");
}

function fmtMoney(n) {
  if (n == null) return "0";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}

/* ===========================
 * Construction dynamique du $match à partir des filtres
 * =========================== */
function buildMatch(filters) {
  const m = {};
  if (filters.year || filters.month) {
    const start = new Date(Date.UTC(filters.year || 1900, (filters.month ? filters.month - 1 : 0), 1, 0, 0, 0));
    const end = filters.month
      ? new Date(Date.UTC(filters.year || 9999, filters.month - 1, 1, 0, 0, 0))
      : new Date(Date.UTC((filters.year || 9999) + 1, 0, 1, 0, 0, 0));
    if (filters.month) {
      // passe à mois suivant
      end.setUTCMonth(end.getUTCMonth() + 1);
    }
    m.date_of_admission = { $gte: start, $lt: end };
  }
  if (filters.medical_condition) m.medical_condition = filters.medical_condition;
  if (filters.insurance_provider) m["insurance.provider"] = filters.insurance_provider;
  if (filters.test_results) m.test_results = filters.test_results;
  if (filters.blood_type) m["patient.blood_type"] = filters.blood_type;
  if (filters.gender) m["patient.gender"] = filters.gender;
  return m;
}

/* ===========================
 * Connexion collection
 * =========================== */
const dbx = db.getSiblingDB(DB_NAME);
const col = dbx.getCollection(COLL);
const MATCH = buildMatch(FILTERS);

/* ===========================
 * 1) KPI globaux
 * =========================== */
hr("KPI globaux (avec filtres appliqués)");
const kpi = col.aggregate([
  { $match: MATCH },
  {
    $group: {
      _id: null,
      total_billing_amount: { $sum: "$billing_amount" },
      hospitals: { $addToSet: "$hospital" },
      patients: { $addToSet: "$patient.name.full" }, // si un identifiant patient existe, remplace par ce champ
      doctors: { $addToSet: "$doctor" },
      insurance: { $addToSet: "$insurance.provider" }
    }
  },
  {
    $project: {
      _id: 0,
      total_billing_amount: 1,
      total_hospital: { $size: "$hospitals" },
      total_patient: { $size: "$patients" },
      total_doctors: { $size: "$doctors" },
      total_insurance_company: { $size: "$insurance" }
    }
  }
]).toArray()[0] || {
  total_billing_amount: 0, total_hospital: 0, total_patient: 0, total_doctors: 0, total_insurance_company: 0
};

printjson({
  total_billing_amount: kpi.total_billing_amount,
  total_hospital: kpi.total_hospital,
  total_patient: kpi.total_patient,
  total_doctors: kpi.total_doctors,
  total_insurance_company: kpi.total_insurance_company
});

/* ===========================
 * 2) Total Billing Amount by Year
 * =========================== */
hr("Montant total facturé par année");
const byYear = col.aggregate([
  { $match: MATCH },
  {
    $group: {
      _id: { year: { $year: "$date_of_admission" } },
      total_billing_amount: { $sum: "$billing_amount" }
    }
  },
  { $project: { _id: 0, year: "$_id.year", total_billing_amount: 1 } },
  { $sort: { year: 1 } }
]).toArray();

byYear.forEach(x => print(`${x.year}: ${fmtMoney(x.total_billing_amount)}`));

/* ===========================
 * 3) Total patient by Age Group (13–17, 18–35, 36–55, 56–65, 66+)
 *    Comptage de patients distincts par tranche d'âge
 * =========================== */
hr("Nombre total de patients par tranche d'âge (patients distincts)");
const byAgeGroup = col.aggregate([
  { $match: MATCH },
  {
    $addFields: {
      age_group: {
        $switch: {
          branches: [
            { case: { $and: [ { $gte: ["$patient.age", 13] }, { $lte: ["$patient.age", 17] } ] }, then: "13-17" },
            { case: { $and: [ { $gte: ["$patient.age", 18] }, { $lte: ["$patient.age", 35] } ] }, then: "18-35" },
            { case: { $and: [ { $gte: ["$patient.age", 36] }, { $lte: ["$patient.age", 55] } ] }, then: "36-55" },
            { case: { $and: [ { $gte: ["$patient.age", 56] }, { $lte: ["$patient.age", 65] } ] }, then: "56-65" },
          ],
          default: "66+"
        }
      }
    }
  },
  {
    $group: {
      _id: "$age_group",
      patients: { $addToSet: "$patient.name.full" }
    }
  },
  { $project: { _id: 0, age_group: "$_id", total_patient: { $size: "$patients" } } },
  {
    $addFields: {
      sortKey: {
        $switch: {
          branches: [
            { case: { $eq: ["$age_group", "13-17"] }, then: 1 },
            { case: { $eq: ["$age_group", "18-35"] }, then: 2 },
            { case: { $eq: ["$age_group", "36-55"] }, then: 3 },
            { case: { $eq: ["$age_group", "56-65"] }, then: 4 },
          ],
          default: 5
        }
      }
    }
  },
  { $sort: { sortKey: 1 } },
  { $project: { sortKey: 0 } }
]).toArray();

printjson(byAgeGroup);

/* ===========================
 * 4) Total patient by Gender (patients distincts)
 * =========================== */
hr("Nombre total de patients par sexe (patients distincts)");
const byGender = col.aggregate([
  { $match: MATCH },
  {
    $group: {
      _id: "$patient.gender",
      patients: { $addToSet: "$patient.name.full" }
    }
  },
  { $project: { _id: 0, gender: "$_id", total_patient: { $size: "$patients" } } },
  { $sort: { gender: 1 } }
]).toArray();

// pourcentage
const totalGender = byGender.reduce((s, x) => s + x.total_patient, 0) || 1;
byGender.forEach(x => x.percentage = Math.round((x.total_patient / totalGender) * 10000) / 100);
printjson(byGender);

/* ===========================
 * 5) Total patient by Medical Condition (Top N, patients distincts)
 * =========================== */
hr("Nombre total de patients par affection médicale (Top 10, patients distincts)");
const byCondition = col.aggregate([
  { $match: MATCH },
  {
    $group: {
      _id: "$medical_condition",
      patients: { $addToSet: "$patient.name.full" }
    }
  },
  { $project: { _id: 0, medical_condition: "$_id", total_patient: { $size: "$patients" } } },
  { $sort: { total_patient: -1, medical_condition: 1 } },
  { $limit: 10 }
]).toArray();
printjson(byCondition);

/* ===========================
 * 6) Total patient by Admission Type (patients distincts)
 * =========================== */
hr("Nombre total de patients par type d'admission (patients distincts)");
const byAdmissionType = col.aggregate([
  { $match: MATCH },
  {
    $group: {
      _id: "$admission_type",
      patients: { $addToSet: "$patient.name.full" }
    }
  },
  { $project: { _id: 0, admission_type: "$_id", total_patient: { $size: "$patients" } } },
  { $sort: { total_patient: -1, admission_type: 1 } }
]).toArray();
printjson(byAdmissionType);

/* ===========================
 * 7) Total Billing Amount by Insurance Provider (+ %)
 * =========================== */
hr("Montant total facturé par l'assureur (+ pourcentage)");
const byIns = col.aggregate([
  { $match: MATCH },
  { $group: { _id: "$insurance.provider", total_billing_amount: { $sum: "$billing_amount" } } },
  { $project: { _id: 0, insurance_provider: "$_id", total_billing_amount: 1 } },
  { $sort: { total_billing_amount: -1, insurance_provider: 1 } }
]).toArray();

const billingTotal = byIns.reduce((s, x) => s + (x.total_billing_amount || 0), 0) || 1;
byIns.forEach(x => x.percentage = Math.round((x.total_billing_amount / billingTotal) * 10000) / 100);
printjson(byIns);

/* ===========================
 * Récapitulatif final condensé
 * =========================== */
hr("Récapitulatif");
print("KPI:");
printjson(kpi);
print("\nFacturation annuelle:");
printjson(byYear);
print("\nGroupes Age :");
printjson(byAgeGroup);
print("\nGenre:");
printjson(byGender);
print("\nCondition Médicale (Top 10):");
printjson(byCondition);
print("\nType Admission:");
printjson(byAdmissionType);
print("\nAssurance Santé:");
printjson(byIns);
print("\nTerminé.");
