FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web apps/web
RUN npm --workspace apps/web run build

FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html/app
COPY *.html /usr/share/nginx/html/
COPY script.js /usr/share/nginx/html/script.js
COPY pages.js /usr/share/nginx/html/pages.js
COPY styles.css /usr/share/nginx/html/styles.css
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
