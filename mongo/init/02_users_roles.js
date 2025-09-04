const dbName = process.env.MONGO_DBNAME || "medical";
const admin = db.getSiblingDB("admin");

// Rôles
admin.runCommand({
  createRole: "analystRead",
  privileges: [
    { resource: { db: dbName, collection: "" }, actions: ["find", "listCollections", "dbStats"] }
  ],
  roles: []
});
admin.runCommand({
  createRole: "dataIngestor",
  privileges: [
    { resource: { db: dbName, collection: "" }, actions: ["insert", "update", "find", "listCollections", "bypassDocumentValidation"] }
  ],
  roles: []
});
admin.runCommand({
  createRole: "dbManager",
  privileges: [
    { resource: { db: dbName, collection: "" }, actions: ["createCollection", "collMod", "createIndex", "dropIndex", "validate"] }
  ],
  roles: []
});

// Utilisateurs (secrets via variables d'env)
function getenv(name, fallback) {
  try { return process.env[name] || fallback; } catch (e) { return fallback; }
}
admin.createUser({
  user: getenv("MONGO_APP_INGESTOR_USER", "ingestor"),
  pwd: getenv("MONGO_APP_INGESTOR_PASSWORD", "ingestor"),
  roles: [ { role: "dataIngestor", db: "admin" } ]
});
admin.createUser({
  user: getenv("MONGO_APP_ANALYST_USER", "analyst"),
  pwd: getenv("MONGO_APP_ANALYST_PASSWORD", "analyst"),
  roles: [ { role: "analystRead", db: "admin" } ]
});
admin.createUser({
  user: getenv("MONGO_APP_DBADMIN_USER", "dbadmin"),
  pwd: getenv("MONGO_APP_DBADMIN_PASSWORD", "dbadmin"),
  roles: [ { role: "dbManager", db: "admin" } ]
});
