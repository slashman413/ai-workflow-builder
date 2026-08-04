FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV WORKFLOW_ID=wf_dep
ENV WORKFLOW_NODES=1
EXPOSE 8080
CMD ["npm", "start"]
