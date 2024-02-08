# Use the official Node.js 16 image as a parent image
FROM node:16-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json (if available) to the working directory
COPY src/ ./

# Install any dependencies
RUN npm install

# Define the command to run your app using CMD which defines your runtime
CMD ["npm", "start"]
