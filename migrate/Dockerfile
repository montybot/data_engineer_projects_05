FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Migrateur et config
COPY main.py ./main.py
COPY config ./config

# Runner (téléchargement -> extraction -> détection CSV -> migration)
COPY runner.py ./runner.py

ENTRYPOINT ["python", "runner.py"]
