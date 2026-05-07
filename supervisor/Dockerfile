FROM python:3.13.0-bullseye
WORKDIR /supervisor
COPY app/ /supervisor/app/
COPY setup.py /supervisor/setup.py
COPY requirements.txt /supervisor/requirements.txt
RUN apt-get update && apt-get install -y docker.io && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir -e .
EXPOSE 5151
CMD ["python", "-m", "flask", "--app", "app.routes", "run", "--port", "5151", "--host", "0.0.0.0"]
