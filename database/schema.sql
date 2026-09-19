CREATE DATABASE IF NOT EXISTS wikipedia_time_machine;

USE wikipedia_time_machine;

CREATE TABLE articles (
    id INT PRIMARY KEY,
    title VARCHAR(250) NOT NULL,
    content LONGTEXT
) WITH SYSTEM VERSIONING;