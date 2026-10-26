# Brief: llm-status image (Flask + NVML), built by compose.yml on the GPU VM
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir flask==3.1.3 requests==2.34.2 PyYAML==6.0.3 nvidia-ml-py==13.615.71
COPY llm_status.py .
CMD ["python", "llm_status.py"]
