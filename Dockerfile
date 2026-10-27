FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json jest.config.js ./
COPY src/ src/
COPY e2e/ e2e/
COPY __tests__/ __tests__/
COPY scripts/ scripts/

RUN npm run build
RUN chmod +x scripts/entrypoint.sh

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
