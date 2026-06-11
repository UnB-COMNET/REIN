FROM python:3.13-slim

WORKDIR /gui

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY templates/ templates/

EXPOSE 8080

CMD ["python", "app.py"]
