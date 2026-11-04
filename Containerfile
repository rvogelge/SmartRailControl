FROM docker.io/library/node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
ENV SMARTRAILCONTROL_SERIAL_DISABLED=true
EXPOSE 3000
CMD ["npm", "start"]
