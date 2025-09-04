import os, sys, pathlib, zipfile
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import main as migrate_main

def log(m): 
    print(m, flush=True)

def ensure_dir(p: pathlib.Path):
    p.mkdir(parents=True, exist_ok=True)

def find_first_csv(search_dir: pathlib.Path):
    candidates = sorted(search_dir.rglob("*.csv"))
    return candidates[0] if candidates else None

def download_zip(url: str, zip_path: pathlib.Path) -> bool:
    if zip_path.exists() and zip_path.stat().st_size > 0:
        log(f"ZIP déjà présent: {zip_path}")
        return True
    log(f"Téléchargement depuis {url} …")
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 Python-urllib"})
    try:
        with urlopen(req, timeout=120) as resp:
            if resp.status != 200:
                log(f"Statut HTTP inattendu: {resp.status}")
                return False
            data = resp.read()
            ensure_dir(zip_path.parent)
            with open(zip_path, "wb") as f:
                f.write(data)
            log(f"Téléchargement OK: {zip_path} ({len(data)} octets)")
            return True
    except HTTPError as e:
        log(f"HTTPError: {e.code} {e.reason}")
    except URLError as e:
        log(f"URLError: {e.reason}")
    except Exception as e:
        log(f"Erreur de téléchargement: {e}")
    return False

def extract_zip(zip_path: pathlib.Path, out_dir: pathlib.Path):
    log(f"Extraction du ZIP vers {out_dir} …")
    ensure_dir(out_dir)
    with zipfile.ZipFile(zip_path, "r") as z:
        z.extractall(out_dir)
    log("Extraction terminée.")

def main():
    dataset_url = os.getenv("DATASET_URL", "").strip()
    data_dir = pathlib.Path(os.getenv("DATA_DIR", "/data/healthcare"))
    zip_path = pathlib.Path(os.getenv("DATA_ZIP", str(data_dir / "healthcare-dataset.zip")))
    migration_file_env = os.getenv("MIGRATION_FILE", "").strip()

    ensure_dir(data_dir)

    if dataset_url:
        ok = download_zip(dataset_url, zip_path)
        if not ok:
            csv_existing = find_first_csv(data_dir)
            if csv_existing:
                log(f"Téléchargement indisponible, CSV trouvé: {csv_existing}")
            else:
                log("Échec du téléchargement et aucun CSV local. Abandon.")
                sys.exit(3)
    else:
        log("DATASET_URL non défini. On suppose qu'un CSV existe déjà.")

    if zip_path.exists() and zip_path.stat().st_size > 0:
        try:
            extract_zip(zip_path, data_dir)
        except zipfile.BadZipFile:
            log("ZIP invalide. Tentative de continuer si un CSV est présent.")
        except Exception as e:
            log(f"Erreur d’extraction: {e}")

    migration_file = migration_file_env
    if not migration_file:
        csv_path = find_first_csv(data_dir)
        if not csv_path:
            log("Aucun CSV trouvé après extraction.")
            sys.exit(4)
        migration_file = str(csv_path)
        os.environ["MIGRATION_FILE"] = migration_file
        log(f"MIGRATION_FILE auto-détecté: {migration_file}")
    else:
        log(f"MIGRATION_FILE fourni: {migration_file}")

    log("Démarrage de la migration …")
    migrate_main.main()
    log("Migration terminée.")

if __name__ == "__main__":
    main()
