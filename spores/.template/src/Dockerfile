# Extends the base spore:latest image with this agent's own source.
# node_modules come from the base image — only .js files are overridden.
# To update source: edit files in this directory, then:
#   docker compose up --build -d
FROM spore:latest
USER root
COPY . /app/
RUN chown -R spore:spore /app
