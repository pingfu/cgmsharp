# Use the official Node.js 16 image as a parent image
FROM node:16-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json
COPY src/package*.json ./

# Install any dependencies
RUN npm install

# Copy application code
COPY src/ ./

# Define the command to run your app using CMD which defines your runtime
CMD ["npm", "start"]
