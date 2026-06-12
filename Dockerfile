FROM node:20-slim

WORKDIR /app

# Instalar dependencias necesarias para Baileys
RUN apt-get update && apt-get install -y git python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

EXPOSE 3457

CMD ["node", "fly-bridge.js"]
