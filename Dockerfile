FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
# PORT is provided by Cloud Run (defaults to 8080); server.js reads process.env.PORT
CMD ["node", "server.js"]
