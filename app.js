const express = require('express');
const { Pool } = require('pg');
const OpenAI = require('openai');
require('dotenv').config();

const sqlQueries = [
  'SELECT user_id FROM users WHERE user_username = $1',
  `
    SELECT SUM(nd.food_calories) AS total_calories
    FROM foods_3nf f3
    JOIN workouts w ON f3.workout_id = w.workout_id
    JOIN nutrition_details nd ON f3.food_id = nd.food_id
    WHERE w.user_id = $1
      AND w.workout_date >= CURRENT_DATE - INTERVAL '7 days'
  `,
  `
    SELECT ed.exercise_name, ed.exercise_type, we.exercise_duration, w.workout_date
    FROM workout_exercises we
    JOIN workouts w ON we.workout_id = w.workout_id
    JOIN exercise_details ed ON we.exercise_id = ed.exercise_id
    WHERE w.user_id = $1
      AND w.workout_date >= CURRENT_DATE - INTERVAL '7 days'
  `,
  `
    SELECT g.goal_description, g.health_notes
    FROM goals g
    WHERE g.user_id = $1
  `,
  'DELETE FROM suggestions WHERE user_id = $1',
  `
    INSERT INTO suggestions (user_id, suggestion_content, suggestion_date)
    VALUES ($1, $2, NOW())
    RETURNING suggestion_content
  `
];

const app = express();
const port = 5000;

const pool = new Pool({
  user: 'postgres',
  host: process.env.DB_HOST,
  database: 'postgres',
  password: process.env.DB_PASSWORD,
  port: 5432,
  ssl: { rejectUnauthorized: false },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function checkDatabaseConnection() {
  try {
    await pool.query('SELECT NOW()');
    console.log('Database connection successful!');
  } catch (error) {
    console.error('Database connection failed');
    process.exit(1);
  }
}

checkDatabaseConnection();

async function getUserData(username, userQuestion) {
  try {
    const userQuery = 'SELECT user_id FROM users WHERE user_username = $1';
    const userResult = await pool.query(userQuery, [username]);

    if (userResult.rows.length === 0) {
      return { error: 'User not found' };
    }

    const userId = userResult.rows[0].user_id;

    const foodLogsQuery = `
      SELECT SUM(nd.food_calories) AS total_calories
      FROM foods_3nf f3
      JOIN workouts w ON f3.workout_id = w.workout_id
      JOIN nutrition_details nd ON f3.food_id = nd.food_id
      WHERE w.user_id = $1
        AND w.workout_date >= CURRENT_DATE - INTERVAL '7 days'
    `;
    const foodLogs = await pool.query(foodLogsQuery, [userId]);
    const totalCalories = foodLogs.rows[0].total_calories || 0;

    const exerciseLogsQuery = `
      SELECT ed.exercise_name, ed.exercise_type, we.exercise_duration, w.workout_date
      FROM workout_exercises we
      JOIN workouts w ON we.workout_id = w.workout_id
      JOIN exercise_details ed ON we.exercise_id = ed.exercise_id
      WHERE w.user_id = $1
        AND w.workout_date >= CURRENT_DATE - INTERVAL '7 days'
    `;
    const exerciseLogs = await pool.query(exerciseLogsQuery, [userId]);

    const workoutDates = new Set(exerciseLogs.rows.map((log) => log.workout_date.toISOString().split('T')[0]));
    const totalWorkoutDays = workoutDates.size;

    const goalQuery = `
      SELECT g.goal_description, g.health_notes
      FROM goals g
      WHERE g.user_id = $1
    `;
    const goalResult = await pool.query(goalQuery, [userId]);

    const goal = goalResult.rows.length > 0 ? goalResult.rows[0].goal_description : 'No goal provided';
    const healthNotes = goalResult.rows.length > 0 ? goalResult.rows[0].health_notes : 'No health notes';

    const prompt = `
      The user has the following goal: ${goal}.
      Health notes: ${healthNotes}.
      They consumed a total of ${totalCalories} calories this week and worked out on ${totalWorkoutDays} days.
      Workouts done: ${exerciseLogs.rows.map((log) => log.exercise_name).join(', ') || 'No workouts logged'}.
      User's question: "${userQuestion}".
      Based on this information, provide a suggestion in 2-3 sentences using specific information from what's given.
    `;
    console.log(prompt);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
      temperature: 0.7,
    });

    const suggestion = completion.choices[0].message.content.trim();

    const deleteQuery = 'DELETE FROM suggestions WHERE user_id = $1';
    await pool.query(deleteQuery, [userId]);

    const insertQuery = `
      INSERT INTO suggestions (user_id, suggestion_content, suggestion_date)
      VALUES ($1, $2, NOW())
      RETURNING suggestion_content, suggestion_id
    `;
    const insertResult = await pool.query(insertQuery, [userId, suggestion]);

    console.log('SQL Queries Used:', sqlQueries);

    return {
      suggestion,
      //suggestion_id: insertResult.rows[0].suggestion_id,
    };
  } catch (error) {
    console.error('Error fetching user data or generating suggestion:', error.message);
    return { error: 'Failed to process data or generate suggestion' };
  }
}

app.post('/generate-suggestion', express.json(), async (req, res) => {
  const { username, question } = req.body;
  const result = await getUserData(username, question);
  if (result.error) {
    res.status(500).json(result);
  } else {
    res.json(result);
  }
});

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});

