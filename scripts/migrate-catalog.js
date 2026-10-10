import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'rasoi'
  });

  console.log('Connected to MySQL database:', process.env.DB_NAME || 'rasoi');

  // 1. Check and add chefs columns
  const [chefCols] = await conn.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'rasoi' AND TABLE_NAME = 'chefs'");
  const chefColNames = new Set(chefCols.map(c => c.COLUMN_NAME));

  if (!chefColNames.has('orders_served')) {
    await conn.query('ALTER TABLE chefs ADD COLUMN orders_served INT NOT NULL DEFAULT 0');
    console.log('Added orders_served to chefs');
  }
  if (!chefColNames.has('color')) {
    await conn.query('ALTER TABLE chefs ADD COLUMN color VARCHAR(20) NULL');
    console.log('Added color to chefs');
  }
  for (const c of ['name_ta', 'city_ta', 'cuisine_ta', 'speciality_ta']) {
    if (!chefColNames.has(c)) {
      await conn.query(`ALTER TABLE chefs ADD COLUMN ${c} VARCHAR(160) NULL`);
      console.log('Added ' + c + ' to chefs');
    }
  }
  if (!chefColNames.has('bio_ta')) {
    await conn.query('ALTER TABLE chefs ADD COLUMN bio_ta TEXT NULL');
    console.log('Added bio_ta to chefs');
  }
  if (chefColNames.has('orders')) {
    await conn.query('UPDATE chefs SET orders_served = orders WHERE orders_served = 0 AND orders IS NOT NULL');
  }

  // 2. Check and add foods columns
  const [foodCols] = await conn.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'rasoi' AND TABLE_NAME = 'foods'");
  const foodColNames = new Set(foodCols.map(c => c.COLUMN_NAME));

  if (!foodColNames.has('available')) {
    await conn.query('ALTER TABLE foods ADD COLUMN available TINYINT(1) NOT NULL DEFAULT 1');
    console.log('Added available to foods');
  }
  if (!foodColNames.has('prep_minutes')) {
    await conn.query('ALTER TABLE foods ADD COLUMN prep_minutes INT NOT NULL DEFAULT 20');
    console.log('Added prep_minutes to foods');
  }
  if (!foodColNames.has('name_ta')) {
    await conn.query('ALTER TABLE foods ADD COLUMN name_ta VARCHAR(220) NULL');
    console.log('Added name_ta to foods');
  }
  if (!foodColNames.has('description_ta')) {
    await conn.query('ALTER TABLE foods ADD COLUMN description_ta TEXT NULL');
    console.log('Added description_ta to foods');
  }
  if (!foodColNames.has('photo_credit')) {
    await conn.query('ALTER TABLE foods ADD COLUMN photo_credit JSON NULL');
    console.log('Added photo_credit to foods');
  }
  if (!foodColNames.has('photo_query')) {
    await conn.query('ALTER TABLE foods ADD COLUMN photo_query JSON NULL');
    console.log('Added photo_query to foods');
  }

  await conn.query('UPDATE foods SET available = 1 WHERE available IS NULL');
  if (foodColNames.has('prep_time')) {
    await conn.query("ALTER TABLE foods MODIFY COLUMN prep_time VARCHAR(40) NULL DEFAULT '20 min'");
    await conn.query("UPDATE foods SET prep_minutes = CAST(REGEXP_SUBSTR(prep_time, '[0-9]+') AS UNSIGNED) WHERE prep_time IS NOT NULL AND (prep_minutes IS NULL OR prep_minutes = 20)");
  }

  // 3. Sync catalog.json data for chefs
  const catalogPath = path.resolve(__dirname, '../src/data/catalog.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

  for (const c of catalog.chefs) {
    const [existing] = await conn.query('SELECT id FROM chefs WHERE id = ?', [c.id]);
    if (existing.length === 0) {
      await conn.query(
        'INSERT INTO chefs (id, name, name_ta, city, city_ta, cuisine, cuisine_ta, speciality, speciality_ta, bio, bio_ta, experience, rating, orders_served, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [c.id, c.name, c.nameTa || null, c.city, c.cityTa || null, c.cuisine, c.cuisineTa || null, c.speciality, c.specialityTa || null, c.bio, c.bioTa || null, c.experience, c.rating, c.orders || 0, c.color || '#C1531B']
      );
      console.log('Inserted chef ' + c.id);
    } else {
      await conn.query(
        'UPDATE chefs SET name = ?, name_ta = ?, city = ?, city_ta = ?, cuisine = ?, cuisine_ta = ?, speciality = ?, speciality_ta = ?, bio = ?, bio_ta = ?, experience = ?, rating = ?, orders_served = ?, color = ? WHERE id = ?',
        [c.name, c.nameTa || null, c.city, c.cityTa || null, c.cuisine, c.cuisineTa || null, c.speciality, c.specialityTa || null, c.bio, c.bioTa || null, c.experience, c.rating, c.orders || 0, c.color || '#C1531B', c.id]
      );
      console.log('Updated chef ' + c.id);
    }
  }

  // 4. Insert or update catalog.json foods (f01 - f75)
  let foodCount = 0;
  for (const f of catalog.foods) {
    const [existing] = await conn.query('SELECT id FROM foods WHERE id = ?', [f.id]);
    const photo = f.photo || (f.id.endsWith('75') ? '/images/foods/f75.png' : `/images/foods/${f.id}.jpg`);
    const prepMin = f.prepMinutes || 20;
    const prepStr = `${prepMin} min`;
    if (existing.length === 0) {
      await conn.query(
        'INSERT INTO foods (id, name, name_ta, category, meals, chef_id, icon, price, rating, reviews, prep_minutes, prep_time, diet, spice, description, description_ta, tags, photo, available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        [f.id, f.name, f.nameTa || null, f.category, JSON.stringify(f.meals || [f.category]), f.chefId, f.icon || null, f.price, f.rating, f.reviews, prepMin, prepStr, f.diet, f.spice || 'Mild', f.description, f.descriptionTa || null, JSON.stringify(f.tags || []), photo]
      );
      foodCount++;
    } else {
      await conn.query(
        'UPDATE foods SET name = ?, name_ta = ?, category = ?, meals = ?, chef_id = ?, icon = ?, price = ?, rating = ?, reviews = ?, prep_minutes = ?, prep_time = ?, diet = ?, spice = ?, description = ?, description_ta = ?, tags = ?, photo = ?, available = 1 WHERE id = ?',
        [f.name, f.nameTa || null, f.category, JSON.stringify(f.meals || [f.category]), f.chefId, f.icon || null, f.price, f.rating, f.reviews, prepMin, prepStr, f.diet, f.spice || 'Mild', f.description, f.descriptionTa || null, JSON.stringify(f.tags || []), photo, f.id]
      );
      foodCount++;
    }
  }
  console.log(`Synced ${foodCount} foods from catalog.json.`);

  await conn.end();
  console.log('Migration completed successfully!');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
