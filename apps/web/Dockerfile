FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web apps/web
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN npm --workspace apps/web run build

FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html/app
COPY apps/landing/. /usr/share/nginx/html/
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
