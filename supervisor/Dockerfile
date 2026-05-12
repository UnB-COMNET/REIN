FROM python:3.13.0-slim
WORKDIR /supervisor
COPY app/ /supervisor/app/
COPY setup.py /supervisor/setup.py
COPY requirements.txt /supervisor/requirements.txt
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-26.0.0.tgz -o docker.tgz \
    && tar xzvf docker.tgz \
    && mv docker/docker /usr/bin/docker \
    && rm -rf docker docker.tgz
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir -e .
EXPOSE 5151
CMD ["python", "-m", "flask", "--app", "app.routes", "run", "--port", "5151", "--host", "0.0.0.0"]
