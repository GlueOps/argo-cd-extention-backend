FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=8000
EXPOSE 8000

CMD ["npm", "start"]
