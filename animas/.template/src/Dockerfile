# Extends the base anima:latest image with this agent's own source.
# node_modules come from the base image — only .js files are overridden.
# To update source: edit files in this directory, then:
#   docker compose up --build -d
FROM anima:latest
USER root
COPY . /app/
RUN chown -R anima:anima /app
