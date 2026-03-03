FROM python:3.11-slim
ARG PROXY_DEFAULT_TARGET=""

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

ENV PYTHONUNBUFFERED=1
ENV PROXY_DEFAULT_TARGET=${PROXY_DEFAULT_TARGET}


EXPOSE 8080

CMD ["python", "server.py"]
