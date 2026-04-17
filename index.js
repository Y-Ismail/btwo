const express = require('express');
const axios = require('axios');
const cors = require('cors');
const db = require('./db');
const {v7: uuidv7} = require('uuid');

const app = express();
app.use(express.json())
app.use(cors({origin:"*"}));

const PORT = process.env.PORT || 3000;

const getAgeGroup = (age) => {
     if (age <= 12) return "child";
  if (age <= 19) return "teenager";
  if (age <= 59) return "adult";
  return "senior";
}

app.post("/api/profiles", async (req, res) => {
  try {
    const { name } = req.body;

    // Validation
    if (!name || name === "") {
      return res.status(400).json({
        status: "error",
        message: "Missing or empty name"
      });
    }

    if (typeof name !== "string") {
      return res.status(422).json({
        status: "error",
        message: "Invalid type"
      });
    }

    const normalizedName = name.toLowerCase();

    // Check duplicate
    db.get(
      "SELECT * FROM profiles WHERE name = ?",
      [normalizedName],
      async (err, existing) => {
        if (existing) {
          return res.status(200).json({
            status: "success",
            message: "Profile already exists",
            data: existing
          });
        }

        try {
          // Call APIs in parallel
          const [genderRes, ageRes, nationRes] = await Promise.all([
            axios.get(`https://api.genderize.io?name=${normalizedName}`),
            axios.get(`https://api.agify.io?name=${normalizedName}`),
            axios.get(`https://api.nationalize.io?name=${normalizedName}`)
          ]);

          const g = genderRes.data;
          const a = ageRes.data;
          const n = nationRes.data;

          // Edge cases
          if (!g.gender || g.count === 0) {
            return res.status(502).json({
              status: "error",
              message: "Genderize returned an invalid response"
            });
          }

          if (a.age === null) {
            return res.status(502).json({
              status: "error",
              message: "Agify returned an invalid response"
            });
          }

          if (!n.country || n.country.length === 0) {
            return res.status(502).json({
              status: "error",
              message: "Nationalize returned an invalid response"
            });
          }

          // Pick highest probability country
          const topCountry = n.country.reduce((prev, curr) =>
            curr.probability > prev.probability ? curr : prev
          );

          const profile = {
            id: uuidv7(),
            name: normalizedName,
            gender: g.gender,
            gender_probability: g.probability,
            sample_size: g.count,
            age: a.age,
            age_group: getAgeGroup(a.age),
            country_id: topCountry.country_id,
            country_probability: topCountry.probability,
            created_at: new Date().toISOString()
          };

          // Insert into DB
          db.run(
            `INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            Object.values(profile),
            (err) => {
              if (err) {
                return res.status(500).json({
                  status: "error",
                  message: "Database error"
                });
              }

              return res.status(201).json({
                status: "success",
                data: profile
              });
            }
          );
        } catch (err) {
          return res.status(502).json({
            status: "error",
            message: "Upstream API error"
          });
        }
      }
    );
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "Internal server error"
    });
  }
});

/////////////////////////////////////////////////
// 2. GET SINGLE PROFILE
/////////////////////////////////////////////////

app.get("/api/profiles/:id", (req, res) => {
  db.get(
    "SELECT * FROM profiles WHERE id = ?",
    [req.params.id],
    (err, row) => {
      if (!row) {
        return res.status(404).json({
          status: "error",
          message: "Profile not found"
        });
      }

      res.json({
        status: "success",
        data: row
      });
    }
  );
});

/////////////////////////////////////////////////
// 3. GET ALL PROFILES (WITH FILTERS)
/////////////////////////////////////////////////

app.get("/api/profiles", (req, res) => {
  const { gender, country_id, age_group } = req.query;

  let query = "SELECT * FROM profiles WHERE 1=1";
  const params = [];

  if (gender) {
    query += " AND LOWER(gender) = ?";
    params.push(gender.toLowerCase());
  }

  if (country_id) {
    query += " AND LOWER(country_id) = ?";
    params.push(country_id.toLowerCase());
  }

  if (age_group) {
    query += " AND LOWER(age_group) = ?";
    params.push(age_group.toLowerCase());
  }

  db.all(query, params, (err, rows) => {
    res.json({
      status: "success",
      count: rows.length,
      data: rows.map(p => ({
        id: p.id,
        name: p.name,
        gender: p.gender,
        age: p.age,
        age_group: p.age_group,
        country_id: p.country_id
      }))
    });
  });
});

/////////////////////////////////////////////////
// 4. DELETE PROFILE
/////////////////////////////////////////////////

app.delete("/api/profiles/:id", (req, res) => {
  db.run(
    "DELETE FROM profiles WHERE id = ?",
    [req.params.id],
    function (err) {
      if (this.changes === 0) {
        return res.status(404).json({
          status: "error",
          message: "Profile not found"
        });
      }

      res.status(204).send();
    }
  );
});

/////////////////////////////////////////////////

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});