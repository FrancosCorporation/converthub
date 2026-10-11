FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV CONVERTHUB_DB=/data/converthub.db
ENV CONVERTHUB_UPLOADS=/data/uploads
VOLUME /data
EXPOSE 3700
CMD ["node", "server.js"]
