/* 
  Usage:
    # Depuis la racine du projet
    docker exec -i mongo mongosh -u $MONGO_INITDB_ROOT_USERNAME -p $MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase admin < check_duplicates.js

  Paramètres (adapter si nécessaire) :
*/
const DB_NAME = "medical";
const COLL    = "admissions";

// --- Helpers d'affichage ---
function hr(msg) { 
  print("\n============================================================");
  if (msg) print(msg);
  print("============================================================\n");
}

function showTopN(cursor, n = 20) {
  let i = 0;
  while (cursor.hasNext() && i < n) { 
    printjson(cursor.next()); 
    i++;
  }
  if (i === 0) print("(aucun résultat)");
  if (cursor.hasNext()) print(`... (${cursor.objsLeftInBatch()}+ supplémentaires)`);
}

// --- Connexion DB/collection ---
const dbx = db.getSiblingDB(DB_NAME);
const col = dbx.getCollection(COLL);

// --- 0) Info de base ---
hr(`Base: ${DB_NAME} | Collection: ${COLL}`);
const total = col.estimatedDocumentCount();
print(`Documents (estimation rapide): ${total}`);

// --- 1) Vérifier l'existence d'un index unique sur admission_id ---
hr("Vérification de l'index unique sur 'admission_id'");
const indexes = col.getIndexes();
const hasUniqueAdmissionId = indexes.some(ix => ix.key && ix.key.admission_id === 1 && ix.unique === true);
print("Index existants:");
printjson(indexes);

if (!hasUniqueAdmissionId) {
  print("\nATTENTION: aucun index UNIQUE trouvé sur { admission_id: 1 }.");
  print("Commande suggérée (à exécuter séparément avec un compte autorisé) :");
  print("db.admissions.createIndex({ admission_id: 1 }, { unique: true, name: 'uniq_admission_id' })");
} else {
  print("\nOK: un index UNIQUE est présent sur { admission_id: 1 }.");
}

// --- 2) Doublons par admission_id ---
hr("Recherche de doublons par 'admission_id'");

const dupesById = col.aggregate([
  { $group: { _id: "$admission_id", n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
  { $sort: { n: -1, _id: 1 } }
]);

let countDupKeysById = 0;
dupesById.forEach(d => { countDupKeysById++; });

if (countDupKeysById === 0) {
  print("Aucun doublon trouvé par 'admission_id'.");
} else {
  print(`Clés 'admission_id' en doublon: ${countDupKeysById}`);
  print("Exemples (max 20) :");
  const dupesByIdPreview = col.aggregate([
    { $group: { _id: "$admission_id", n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1, _id: 1 } },
    { $limit: 20 }
  ]);
  showTopN(dupesByIdPreview);
  print("\nPour voir toutes les occurrences d'une clé précise, par ex. _id='xxxx':");
  print("db.admissions.find({ admission_id: 'xxxx' }).pretty()");
}

// --- 3) Doublons par clé composite logique ---
// La clé composite utilise le nom déjà normalisé en minuscules
// + le jour UTC de l'admission (YYYY-MM-DD)
// + l'hôpital + la chambre.
hr("Recherche de doublons par clé composite (name.full + date_of_admission[jour] + hospital + room_number)");

const dupesByComposite = col.aggregate([
  {
    $group: {
      _id: {
        name: "$patient.name.full",
        day: { $dateToString: { format: "%Y-%m-%d", date: "$date_of_admission" } },
        hospital: "$hospital",
        room: "$room_number"
      },
      n: { $sum: 1 }
    }
  },
  { $match: { n: { $gt: 1 } } },
  { $sort: { n: -1, "_id.name": 1, "_id.day": 1 } }
]);

let countDupKeysComposite = 0;
dupesByComposite.forEach(d => { countDupKeysComposite++; });

if (countDupKeysComposite === 0) {
  print("Aucun doublon trouvé par clé composite logique.");
} else {
  print(`Clés composites en doublon: ${countDupKeysComposite}`);
  print("Exemples (max 20) :");
  const dupesByCompositePreview = col.aggregate([
    {
      $group: {
        _id: {
          name: "$patient.name.full",
          day: { $dateToString: { format: "%Y-%m-%d", date: "$date_of_admission" } },
          hospital: "$hospital",
          room: "$room_number"
        },
        n: { $sum: 1 }
      }
    },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1, "_id.name": 1, "_id.day": 1 } },
    { $limit: 20 }
  ]);
  showTopN(dupesByCompositePreview);
  print("\nPour inspecter les documents d’une clé composite :");
  print("db.admissions.find({");
  print("  'patient.name.full': '<name_en_minuscule>',");
  print("  hospital: '<hospital>',");
  print("  room_number: '<room>',");
  print("  date_of_admission: {");
  print("    $gte: ISODate('YYYY-MM-DDT00:00:00Z'),");
  print("    $lt:  ISODate('YYYY-MM-DDT00:00:00Z') + 1 jour");
  print("  }");
  print("}).pretty()");
}

// --- 4) Résumé final ---
hr("Résumé");
const exactCount = col.countDocuments({});
print(`Documents (countDocuments exact): ${exactCount}`);
if (countDupKeysById === 0 && countDupKeysComposite === 0) {
  print("Aucun doublon détecté (identifiant et clé composite).");
} else {
  print("Des doublons ont été détectés. Voir sections ci-dessus pour les détails.");
}
print("\nFin du script.");
