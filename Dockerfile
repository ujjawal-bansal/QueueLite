# QueueLite: Spring Boot API + the React app, in one image.
#
# Render builds this (see render.yaml). The same image also serves the React
# build, so a single service can run the whole app; the Vercel frontend keeps
# working unchanged alongside it.

# ---- 1. React frontend ----
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# Empty means "same origin": the page and the API are served together.
ENV VITE_API_BASE_URL=""
RUN npm run build

# ---- 2. Spring Boot API ----
FROM maven:3.9-eclipse-temurin-21 AS backend
WORKDIR /app/backend
COPY backend/pom.xml ./
RUN mvn -q -B dependency:go-offline
COPY backend/src ./src
COPY --from=frontend /app/frontend/dist ./src/main/resources/static
# The tests need an embedded Postgres; they run in CI and locally, not here.
RUN mvn -q -B package -DskipTests

# ---- 3. Runtime ----
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
RUN addgroup -S queuelite && adduser -S queuelite -G queuelite
COPY --from=backend /app/backend/target/queuelite-api.jar ./queuelite-api.jar
USER queuelite

# Sized for Render's free tier (512 MB): the heap takes most of it, the serial
# collector keeps the overhead small.
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=70 -XX:+UseSerialGC -Xss512k"
ENV APP_ENV=production
EXPOSE 3001
ENTRYPOINT ["java", "-jar", "/app/queuelite-api.jar"]
