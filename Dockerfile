# Stage 1: Build the application
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app

# The project is nested inside ChatSystem/ChatSystem
COPY ChatSystem/ChatSystem/pom.xml .
COPY ChatSystem/ChatSystem/src ./src

# Build the jar, skipping tests to speed up the process
RUN mvn clean package -DskipTests

# Stage 2: Run the application
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app

# Copy the built jar from the build stage
COPY --from=build /app/target/ChatSystem-0.0.1-SNAPSHOT.jar app.jar

# Run the app with the HTTP profile by default and expose port 8080
ENV SPRING_PROFILES_ACTIVE=http
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["java", "-jar", "app.jar"]
