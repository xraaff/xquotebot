FROM node:20-alpine
RUN apk add --no-cache python3 make g++ libc6-compat
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "bridge.js"]