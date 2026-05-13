# Dockerfile minimal para campo-realtime
# Node 20 LTS + fetch nativo + ESM. Sin dependencias npm (server.mjs usa solo
# stdlib). El package.json esta solo para que `npm start` ande.
FROM node:20-alpine

WORKDIR /app

# Copiamos package.json primero para aprovechar layer cache, aunque no haya
# deps que instalar (es solo metadata).
COPY package.json ./

# Codigo + estaticos.
COPY server.mjs ./
COPY public ./public

# Puerto interno (Dokploy enruta por nombre, no por puerto host).
ENV PORT=8787 \
    NODE_ENV=production

EXPOSE 8787

# Usuario no-root por buena practica.
USER node

CMD ["node", "server.mjs"]
