FROM node:20-slim AS builder

WORKDIR /app

# Build-time args — Expo bakes EXPO_PUBLIC_* into the JS bundle
ARG EXPO_PUBLIC_API_URL=http://localhost:5000
ARG EXPO_PUBLIC_API_VERSION=v1
ARG GEMINI_API_KEY

ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL
ENV EXPO_PUBLIC_API_VERSION=$EXPO_PUBLIC_API_VERSION
ENV GEMINI_API_KEY=$GEMINI_API_KEY

COPY package*.json ./
RUN npm install

COPY . .

# Build Expo web output → /app/dist
RUN npx expo export --platform web

# ── Serve with nginx ──────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# SPA routing: all paths → index.html (required for Expo Router)
RUN printf 'server {\n\
    listen 80;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
