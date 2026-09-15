## 3. System-versioned tables: History for Free

### The Feature

`WITH SYSTEM VERSIONING` makes a table keep its own history, which can be queried using:

- `FOR SYSTEM_TIME AS OF`
- `FOR SYSTEM_TIME BETWEEN`
- `FOR SYSTEM_TIME ALL`

Application-time periods can model validity ranges independently of when rows were actually written to the database.

Both system-versioned tables and application-time periods are part of the SQL:2011 standard and are built directly into MariaDB Server.

---

### The Project

Build a **time machine for Wikipedia**.

Take a dump of a selected set of Wikipedia articles — a few dozen articles is enough — together with their revision history. The data can be obtained from:

- `dumps.wikimedia.org`
- the MediaWiki API

Load these revisions into a **system-versioned MariaDB table**.

Create a simple page where the user can:

1. Select a Wikipedia article.
2. Pick a moment in time.
3. View the article exactly as it existed at that moment.

If there is enough time, also implement a **diff view** that compares the article between two selected points in time.

The project should also cover the operational side of temporal tables, including:

- how a system-versioned table grows as more historical versions accumulate;
- how partitioning by `SYSTEM_TIME` can be used to keep historical data manageable.

---

### Background

There is an interesting irony behind this project.

Wikipedia itself runs on **MariaDB**, but Wikipedia maintains its revision history using application-level revision tables. These were designed years before database-level system versioning existed.

In this project, the goal is to explore what happens when the database itself is responsible for maintaining history.

Instead of implementing revision tables, triggers, and additional application logic, history can be enabled directly in the table definition using:

```sql
WITH SYSTEM VERSIONING