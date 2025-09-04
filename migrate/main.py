import os, json, csv, sys, pathlib, argparse, hashlib
from datetime import datetime, timezone
from dateutil import parser as dtparser
from pymongo import MongoClient, UpdateOne

# ------------------ utilitaires de structure ------------------ #
def set_nested(doc, dotted_path, value):
    parts = []
    for p in dotted_path.split("."):
        if "[" in p and "]" in p:
            name, idx = p[:-1].split("[")
            parts.append(name); parts.append(int(idx))
        else:
            parts.append(p)
    cur = doc
    for i, key in enumerate(parts):
        last = i == len(parts) - 1
        if isinstance(key, int):
            if not isinstance(cur, list):
                parent = cur
                parent_key = parts[i-1]
                parent[parent_key] = []
                cur = parent[parent_key]
            while len(cur) <= key:
                cur.append({})
            if last:
                cur[key] = value
            else:
                if not isinstance(cur[key], dict):
                    cur[key] = {}
                cur = cur[key]
        else:
            if last:
                cur[key] = value
            else:
                if key not in cur or not isinstance(cur[key], (dict, list)):
                    cur[key] = {}
                cur = cur[key]
    return doc

def get_nested(doc, dotted_path, default=None):
    parts = []
    for p in dotted_path.split("."):
        if "[" in p and "]" in p:
            name, idx = p[:-1].split("[")
            parts.append(name); parts.append(int(idx))
        else:
            parts.append(p)
    cur = doc
    try:
        for key in parts:
            cur = cur[key] if isinstance(key, int) else cur[key]
        return cur
    except Exception:
        return default

# ------------------ mapping & conversions ------------------ #
def apply_mapping(row, mapping):
    doc = {}
    # projection/renommage
    for src, dst in mapping.get("field_renames", {}).items():
        if src in row and row[src] != "":
            set_nested(doc, dst, row[src])

    # conversions
    for path, rule in mapping.get("conversions", {}).items():
        val = get_nested(doc, path, None)
        if val is None:
            continue
        try:
            if rule == "int":
                set_nested(doc, path, int(str(val).strip()))
            elif rule == "float":
                set_nested(doc, path, float(str(val).strip()))
            elif rule == "date":
                parsed = dtparser.parse(str(val))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                set_nested(doc, path, parsed)
            elif rule == "lower":
                set_nested(doc, path, str(val).lower())
            elif rule == "upper":
                set_nested(doc, path, str(val).upper())
            elif isinstance(rule, dict) and "map" in rule:
                set_nested(doc, path, rule["map"].get(str(val), val))
        except Exception:
            # on laisse la valeur telle quelle si conversion impossible
            pass
    return doc

# ------------------ normalisations spécifiques ------------------ #
def split_name(full):
    if not full:
        return None, None
    parts = str(full).strip().split()
    if len(parts) == 1:
        return parts[0], None
    return " ".join(parts[:-1]), parts[-1]

def compute_admission_id(full_name, doa_iso, hospital, room):
    key = "|".join([
        (full_name or "").strip().lower(),
        (doa_iso or "").strip(),
        (hospital or "").strip().lower(),
        (room or "").strip().lower()
    ])
    return hashlib.sha256(key.encode("utf-8")).hexdigest()

def enrich_and_normalize(doc):
    # 1) normaliser le nom en minuscules (exigence)
    full = get_nested(doc, "patient.name.full")
    if isinstance(full, str) and full.strip():
        full_lc = full.strip().lower()
        set_nested(doc, "patient.name.full", full_lc)
        given, family = split_name(full_lc)
        if given:
            set_nested(doc, "patient.name.given", given.lower())
        if family:
            set_nested(doc, "patient.name.family", family.lower())

    # 2) normaliser genre & groupe sanguin
    gender = get_nested(doc, "patient.gender")
    if gender:
        set_nested(doc, "patient.gender", str(gender).lower())

    bt = get_nested(doc, "patient.blood_type")
    if bt:
        set_nested(doc, "patient.blood_type", str(bt).upper())

    # 3) normaliser assureur sur vocabulaire fermé
    prov = get_nested(doc, "insurance.provider")
    #allowed = {"Aetna", "Blue Cross", "Cigna", "UnitedHealthcare", "Medicare"}
    #if prov and prov not in allowed:
    #    set_nested(doc, "insurance.provider", "Other")

    # 4) calcul de l'identifiant fonctionnel déterministe
    doa = get_nested(doc, "date_of_admission")
    doa_iso = doa.date().isoformat() if isinstance(doa, datetime) else str(doa or "")
    adm_id = compute_admission_id(
        get_nested(doc, "patient.name.full"),
        doa_iso,
        get_nested(doc, "hospital"),
        get_nested(doc, "room_number"),
    )
    doc["admission_id"] = adm_id

    # 5) durée d'admission si dates présentes
    dd = get_nested(doc, "discharge_date")
    if isinstance(doa, datetime) and isinstance(dd, datetime):
        delta = (dd - doa).days
        doc["admission_duration_days"] = int(delta) if delta >= 0 else None

    return doc

# ------------------ programme principal ------------------ #
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--uri", default=os.getenv("MONGODB_URI"))
    parser.add_argument("--db", default=os.getenv("MONGO_DBNAME", "medical"))
    parser.add_argument("--collection", default=os.getenv("MIGRATION_COLLECTION", "admissions"))
    parser.add_argument("--file", default=os.getenv("MIGRATION_FILE", ""))
    parser.add_argument("--id-key", default=os.getenv("MIGRATION_ID_KEY", "admission_id"))
    parser.add_argument("--mapping", default=os.getenv("MIGRATION_MAPPING"))
    parser.add_argument("--batch-size", type=int, default=2000)
    args = parser.parse_args()

    if not args.uri:
        print("Erreur: MONGODB_URI manquant.", file=sys.stderr); sys.exit(1)

    client = MongoClient(args.uri)
    db = client[args.db]
    col = db[args.collection]

    mapping = {}
    if args.mapping and pathlib.Path(args.mapping).exists():
        with open(args.mapping, "r", encoding="utf-8") as f:
            mapping = json.load(f)

    file_path = args.file
    if not file_path or not pathlib.Path(file_path).exists():
        print("Erreur: fichier CSV non fourni ou introuvable.", file=sys.stderr); sys.exit(2)

    # Compteurs & déduplication in-session
    csv_total = 0               # nombre de lignes lues dans le CSV
    unique_total = 0            # nombre de lignes uniques réellement traitées (après dédoublonnage)
    batch_ok = 0                # total d'opérations réussies (matched+modified+upserted)
    seen_ids = set()            # admission_id déjà vus durant CET import

    now = datetime.now(timezone.utc)
    ops = []

    with open(file_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            csv_total += 1

            # 1) mapping & conversions
            doc = apply_mapping(row, mapping) if mapping else dict(row)

            # 2) enrichissements + normalisations (dont name -> minuscules)
            doc = enrich_and_normalize(doc)

            # 3) timestamps
            doc.setdefault("created_at", now)
            doc["updated_at"] = now

            # 4) identifiant requis
            id_key = args.id_key
            if id_key not in doc or not doc[id_key]:
                print(f"Ligne {csv_total}: identifiant '{id_key}' manquant, ignorée.", file=sys.stderr)
                continue

            # 5) dédoublonnage dans la session d'import
            adm_id = doc[id_key]
            if adm_id in seen_ids:
                # doublon de CSV (même admission_id) -> on ignore
                continue
            seen_ids.add(adm_id)
            unique_total += 1

            # 6) upsert
            ops.append(UpdateOne({id_key: adm_id}, {"$set": doc}, upsert=True))

            if len(ops) >= args.batch_size:
                res = col.bulk_write(ops, ordered=False)
                batch_ok += res.upserted_count + res.modified_count + res.matched_count
                ops = []
                print(f"Progression: {batch_ok}/{unique_total} opérations appliquées...")

    # Reste du lot
    if ops:
        res = col.bulk_write(ops, ordered=False)
        batch_ok += res.upserted_count + res.modified_count + res.matched_count

    # Compte exact actuel dans la base
    try:
        db_exact = col.count_documents({})
    except Exception as e:
        db_exact = None
        print(f"Attention: impossible de calculer count_documents(): {e}", file=sys.stderr)

    # Récapitulatif demandé
    print("------------------------------------------------------------")
    print(f"CSV - lignes lues                : {csv_total}")
    print(f"Lignes uniques (après dédoublon): {unique_total}")
    print(f"Opérations appliquées (matched/modified/upserted): {batch_ok}")
    if db_exact is not None:
        print(f"Documents présents dans la base : {db_exact}")
    print("Terminé.")

if __name__ == "__main__":
    main()
