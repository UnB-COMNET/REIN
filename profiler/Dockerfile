# Brief: REIN profiler (Flask + LangGraph) on 127.0.0.1:5300. The RAG index is versioned in data/;
# rebuild it with scripts/build_index.py after changing data/seeds_rein.tsv
FROM python:3.12-slim
WORKDIR /profiler
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 FASTEMBED_CACHE_PATH=/profiler/.cache/fastembed
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ app/
COPY data/index.npy data/index.json data/
# Bakes the embedding model into the image, so startup needs no download
RUN python -c "from app import rag; rag.embed(['warm-up'])"
CMD ["python", "-m", "app.main"]
