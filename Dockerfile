FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# ffmpeg para os workers de audio/video
RUN apk add --no-cache ffmpeg
ENV CONVERTHUB_DB=/data/jobs.db
VOLUME /data
EXPOSE 3700
CMD ["node", "server.js"]
