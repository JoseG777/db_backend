const express = require('express');
const { Pool } = require('pg');
const OpenAI = require('openai');
require('dotenv').config();

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
      SELECT f.food_calories, w.workout_date
      FROM foods f
      JOIN workouts w ON f.workout_id = w.workout_id
      WHERE w.user_id = $1
    `;
    const foodLogs = await pool.query(foodLogsQuery, [userId]);

    const exerciseLogsQuery = `
      SELECT e.exercise_name, e.exercise_type, e.exercise_duration, w.workout_date
      FROM exercises e
      JOIN workouts w ON e.workout_id = w.workout_id
      WHERE w.user_id = $1
    `;
    const exerciseLogs = await pool.query(exerciseLogsQuery, [userId]);

    const goalQuery = `
      SELECT goal_description, health_notes
      FROM goals
      WHERE goal_id = $1
    `;
    const goalResult = await pool.query(goalQuery, [userId]);

    const goal = goalResult.rows.length > 0 ? goalResult.rows[0].goal_description : 'No goal provided';
    const healthNotes = goalResult.rows.length > 0 ? goalResult.rows[0].health_notes : 'No health notes';

    const totalCalories = foodLogs.rows.reduce((sum, log) => sum + (log.food_calories || 0), 0);
    const workoutDates = new Set(exerciseLogs.rows.map((log) => log.workout_date.toISOString().split('T')[0]));
    const totalWorkoutDays = workoutDates.size;

    const prompt = `
      The user has the following goal: ${goal}.
      Health notes: ${healthNotes}.
      They consumed a total of ${totalCalories * 100} calories this week and worked out on ${totalWorkoutDays} days.
      Workouts done: ${exerciseLogs.rows.map((log) => log.exercise_name).join(', ') || 'No workouts logged'}.
      User's question: "${userQuestion}".
      Based on this information, provide a suggestion in 2-3 sentences.
    `;
    console.log(prompt)

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
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
      RETURNING suggestion_content
    `;
    const insertResult = await pool.query(insertQuery, [userId, suggestion]);

    return {
      suggestion,
      suggestion_id: insertResult.rows[0].suggestion_id,
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
