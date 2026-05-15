FROM python:3.11-slim

# System libs needed by OpenCV + PyMuPDF
RUN apt-get update -qq && apt-get install -y -qq \
		ca-certificates \
	fontconfig \
	libfreetype6 \
		libgl1 \
		libglib2.0-0 \
		libxcb-icccm4 \
		libxcb-image0 \
		libxcb-keysyms1 \
		libxcb-render-util0 \
		libxcb-render0 \
		libxcb-shape0 \
		libxcb-xkb1 \
		libxkbcommon-x11-0 \
	libpng16-16 \
	libxkbcommon0 \
		xvfb \
	&& rm -rf /var/lib/apt/lists/*

# Install ODA File Converter (Linux) for DWG -> DXF conversion
COPY api/ODA/ODAFileConverter_QT6_lnxX64_8.3dll_27.1.deb /tmp/oda.deb
RUN set -eux; \
		apt-get update -qq; \
		apt-get install -y -qq /tmp/oda.deb; \
		rm -f /tmp/oda.deb; \
		ODA_BIN="$(command -v ODAFileConverter)"; \
		mkdir -p /opt/oda; \
		ln -sf "$ODA_BIN" /opt/oda/ODAFileConverter; \
		rm -rf /var/lib/apt/lists/*

# Bundle QCAD binaries for DWG preview rendering in cloud environments
COPY qcad-3.32.6-trial-linux-x86_64 /opt/qcad
RUN set -eux; \
		# Strip any Windows CR from shell-script wrappers (autocrlf safety net)
		find /opt/qcad -maxdepth 1 -type f ! -name '*.so*' -exec \
			sh -c 'head -c2 "$1" | grep -q "#!" && sed -i "s/\r$//" "$1"' _ {} \; ; \
		if [ -d /opt/qcad ]; then \
			for f in /opt/qcad/dwg2bmp /opt/qcad/qcad-bin /opt/qcad/qcad; do \
				if [ -f "$f" ]; then chmod +x "$f"; fi; \
			done; \
			test -f /opt/qcad/libqcadecmaapi.so || (echo "ERROR: /opt/qcad/libqcadecmaapi.so missing. Ensure QCAD .so files are committed to repository." >&2; exit 1); \
			find /opt/qcad -maxdepth 1 -type f -name '*.so*' -exec cp {} /usr/lib/ \; ; \
			ldconfig; \
			echo "QCAD core library found."; \
			if [ -x /opt/qcad/qcad ]; then \
				if /opt/qcad/qcad -platform offscreen -version >/tmp/qcad_version.txt 2>/tmp/qcad_version_err.txt; then \
					cat /tmp/qcad_version.txt; \
				else \
					echo "QCAD version sanity check failed at build time (non-fatal)."; \
					tail -n 80 /tmp/qcad_version_err.txt || true; \
				fi; \
			else \
				echo "QCAD executable missing at build time (non-fatal)."; \
			fi; \
		else \
			echo "QCAD directory missing at build time (non-fatal)."; \
		fi

WORKDIR /app
COPY api/requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY api/app /app/app

# Copy .env so python-dotenv can load it at runtime
#COPY .env /app/.env

ENV PYTHONUNBUFFERED=1
ENV DB_ENGINE=postgres
ENV DB_HOST=34.136.196.160
ENV DB_PORT=5432
ENV DB_NAME=firecad
ENV DB_SSLMODE=prefer
ENV ODA_PATH=/opt/oda/ODAFileConverter
ENV QCAD_DWG2BMP=/opt/qcad/dwg2bmp
ENV USE_QCAD_DWG2BMP=1
ENV LD_LIBRARY_PATH=/opt/qcad
ENV GCS_BUCKET=mepit

EXPOSE 8000
CMD ["python", "-m", "app.server"]
