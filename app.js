const express = require("express");
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser')
const multer = require('multer')
const ftpStorage = require('multer-ftp')
const { Client } = require("basic-ftp")
const cors = require('cors');

require('@dotenvx/dotenvx').config();

var dbpool = mysql.createPool({
  connectionLimit: 10,
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PWD,
  database: process.env.DB_NAME,
  waitForConnections: true,
});

const ftpCred = {
  host: process.env.FTP_HOST,
  user: process.env.FTP_USER,
  password: process.env.FTP_PWD,
  secure: false,
};

var storage = new ftpStorage({
  basepath: '/stimuli/',
  ftp: ftpCred,
  destination: function (req, file, options, callback) {
    const name = `${req.params["poolId"]}/${file.originalname}`
    callback(null, name)
  },
});

const upload = multer({ storage: storage });

const app = express();
app.use(cors());

app.use(bodyParser.json());

const port = process.env.PORT || 3001;

const basicAuth = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const base64Credentials = authHeader.split(" ")[1];
  const credentials = Buffer.from(base64Credentials, "base64").toString("utf-8");
  const [username, password] = credentials.split(":");

  if (username === "admin" && password === process.env.PASSWORD) {
    return next();
  }

  return res.status(401).json({ message: "Invalid credentials" });
};

const getRandom = (arr, n, exc) => {
  if (n < 0 || (n - 1) > arr.length) {
    throw new Error('n must be a non-negative number and not exceed the array\'s length.');
  }

  const tempArray = arr.filter(e => !exc.includes(e));
  const result = [];
  for (let i = 0; i < n; i++) {
    const randomIndex = Math.floor(Math.random() * tempArray.length);
    result.push(tempArray[randomIndex]);
    tempArray.splice(randomIndex, 1);
  }

  return result;
};

async function createDir(dirName) {
  let client = new Client();
  try {
    await client.access(ftpCred);
    await client.ensureDir(dirName);
  }
  catch (err) {
    console.log(err);
    client.close();
    return false;
  }
  client.close();
  return true;
}

async function getPools() {
  let client = new Client();
  try {
    await client.access(ftpCred);
    const pools = await client.list();
    const res = { "pools": pools.map((di) => di.name).filter((n) => n[0] !== ".") };
    client.close();
    return res;
  }
  catch (err) {
    console.log(err);
    client.close();
    return null;
  }
}

async function getStimuli(poolId) {
  console.log("Getting stimuli from FTP server");
  let client = new Client();
  try {
    await client.access(ftpCred);
    await client.cd(`${poolId}/`);
    const stimuli = await client.list();
    const res = { "stimuli": stimuli };
    client.close();
    return res;

  }
  catch (err) {
    console.log(err);
    client.close();
    return null;
  }
}

async function get_stimulus(poolId, stimulusId, stream) {
  let client = new Client(1000 * 1000);
  try {
    await client.access(ftpCred);

    const pools = (await client.list()).map((di) => di.name).filter((n) => n[0] !== ".");
    if (!pools.includes(poolId)) {
      throw new Error(`Invalid poolId: ${poolId}`);
    }

    await client.cd(`${poolId}`);

    const stimuli = (await client.list()).map((di) => di.name).filter((n) => n[0] !== ".");
    if (!stimuli.includes(stimulusId)) {
      throw new Error(`Invalid stimulusId: ${stimulusId}`);
    }

    await client.downloadTo(stream, stimulusId);
    client.close();
    return;

  }
  catch (err) {
    console.log(err);
    client.close();
    throw err;
  }
}

// Pool
// app.get("/pool", basicAuth, async (req, res) => {
app.get("/pool", async (req, res) => {
  console.log(`Get /pool/ Listing pools`);
  const pools = await getPools();
  if (pools === null) {
    res.sendStatus(400);
  } else {
    res.json(pools);
  }
});

app.get("/pool/:poolId", upload.none(), async (req, res) => {
  console.log(`Get/pool/${req.params.poolId} Listing stimuli`);
  const stimuli = await getStimuli(req.params["poolId"]);
  if (stimuli === null) {
    res.sendStatus(400);
  } else {
    res.json(stimuli);
  }
});

app.get("/pool/:poolId/:stimulusId", upload.none(), async (req, res) => {
  console.log(`Get /pool/${req.params.poolId}/${req.params.stimulusId} Downloading stimulus`);
  res.setHeader("Content-Disposition", `attachment; filename="${req.params["stimulusId"]}"`);
  res.setHeader("Content-Type", "application/octet-stream");
  try {
    get_stimulus(req.params["poolId"], req.params["stimulusId"], res);
  } catch (e) {
    res.status(400).json(e);
  }
});

app.post("/pool/", upload.none(), async (req, res) => {
  console.log(`POST /pool/ Creating pool:${req.body.poolId}`);
  if (await createDir(req.body.poolId)) {
    res.sendStatus(201);
  } else {
    res.sendStatus(400);
  }
});

app.post("/pool/:poolId", upload.array("stimuli"), (req, res) => {
  console.log(`POST /pool/${req.params.poolId} Adding files to pool: ${req.files.map(e => e.originalname)}`);
  res.sendStatus(200);
});

// Experiment

app.post("/experiment/", upload.none(), async (req, res) => {
  console.log(`POST /experiment/ Creating an experiment`);
  let rel, blocks;

  try {
    rel = JSON.parse(req.body.rel);
    blocks = JSON.parse(req.body.blocks);

    const connection = await dbpool.getConnection();
    try {
      await connection.beginTransaction();

      const q_exp = 'INSERT INTO experiments(`name`, `feedback`, `pool_id`) VALUES (?, ?, ?)';
      const vals_exp = [req.body.name, req.body.feedback === "on", req.body.pool_id];
      try {
        const [exp_rows, exp_fields] = await connection.query(q_exp, vals_exp);
        const experiment_id = exp_rows.insertId;
        let rel_ids = [];
        const q_block = 'INSERT INTO blocks(`experiment_id`, `block_idx`, `type`, `n_trials`, `n_dist`) VALUES (?, ?, ?, ?, ?)';
        for (const block of blocks) {
          const q_values = [experiment_id, block.block_idx, block.type, block.n_trials, block.n_dist];
          const [block_rows, block_fields] = await connection.query(q_block, q_values);
        }

        const q_rel = 'INSERT INTO `relations`(`experiment_id`, `l`, `r`) VALUES (?, ?, ?)';
        for (const rel_k in rel) {
          for (const stId_idx in rel[rel_k]) {
            const stId = rel[rel_k][stId_idx];
            const [rel_rows, rel_fields] = await connection.query(q_rel, [experiment_id, rel_k, stId]);
            // rel_ids.push(rel_rows.insertId);
          }
        }
        await connection.commit();
        dbpool.releaseConnection(connection);
        res.status(201).send({ "experiment_id": experiment_id });
      } catch (e) {
        await connection.rollback();
        throw e;
      }
    } catch (e) {
      dbpool.releaseConnection(connection);
      throw e;
    }
  } catch (e) {
    res.status(400).send(e.message);
  }
});

app.get("/experiment/", upload.none(), async (req, res) => {
  console.log(`GET /experiment/ Get experiments`);
  const q = `SELECT * FROM experiments;`
  const values = []

  const [rows, fields] = await dbpool.query(q, values).catch(e => {
    console.log(e);
    res.status(400).send(e.message);
    return;
  });
  res.json(rows);
});

app.get("/experiment/:experimentName", upload.none(), async (req, res) => {
  console.log(`GET /experiment/${req.params.experimentName} Get experiment by name`);
  const q = `SELECT * FROM experiments WHERE name = ?;`
  const values = [req.params.experimentName]

  const [rows, fields] = await dbpool.query(q, values).catch(e => {
    console.log(e);
    res.status(400).send({ message: `Invalid experiment name ${req.params.experimentName}. ${e}` });
    return;
  });

  if (rows.length != 1) {
    console.log(`Experiment ${req.params.experimentName} not found.`);
    res.status(400).send(e.message);
    return;
  }
  res.json(rows[0]);
});

// Session
app.get("/session/", upload.none(), async (req, res) => {
  console.log(`GET /session/ Get sessions`);
  const q_check = `SELECT * FROM sessions;`
  const [rows, fields] = await dbpool.query(q_check, []).catch(e => {
    console.log(e);
    res.status(400).send(e.message);
    return;
  });
  res.json(rows);
});


app.post("/session/", upload.none(), async (req, res) => {
  const experiment_id = req.body.experimentId;
  const session_name = req.body.sessionName;
  console.log(`POST /session/${experiment_id}/${session_name} Creating session`);

  // Check if we already have a session with the same (id, name)
  const q_check = `SELECT * FROM sessions WHERE name = ? AND experiment_id = ?;`
  const [rows_check, fields_check] = await dbpool.query(q_check, [experiment_id, session_name]).catch(e => {
    console.log(e);
    res.status(400).send(e.message);
    return;
  });

  if (rows_check.length >= 1) {
    console.log(`Session already exists.`);
    res.status(400).send(`Session already exists.`);
    return;
  }

  const q_exp = `SELECT * FROM experiments WHERE experiment_id = ?;`

  const [rows_exp, fields_exp] = await dbpool.query(q_exp, [experiment_id]).catch(e => {
    console.log(e);
    res.status(400).send(`Failed to get experiment.`);
    return;
  });

  if (rows_exp.length != 1) {
    console.log(`Experiment ${experiment_id} not found.`);
    res.status(400).send(`Experiment not found.`);
    return;
  }
  const exp = rows_exp[0];

  const pool = (await getStimuli(exp.pool_id))["stimuli"].map(e => e.name);

  const q_block = `SELECT * FROM blocks WHERE experiment_id = ?;`
  const values_block = [experiment_id]

  const [blocks, fields_block] = await dbpool.query(q_block, values_block).catch(e => {
    console.log(e);
    res.status(400).send({ message: `Failed to get blocks. ${e}` });
    return;
  });

  const q_rel = `SELECT * FROM relations WHERE experiment_id = ?;`
  const values_rel = [experiment_id]

  const [rel, fields_rel] = await dbpool.query(q_rel, values_rel).catch(e => {
    console.log(e);
    res.status(400).send({ message: `Failed to get relation. ${e}` });
    return;
  });

  let relMap = {};
  for (let i = 0; i < rel.length; i++) {
    if (!(rel[i].l in relMap)) {
      relMap[rel[i].l] = [];
    }
    relMap[rel[i].l].push(rel[i].r);
  }

  const connection = await dbpool.getConnection().catch(e => {
    console.log(e);
    res.status(400).send(`Unable to connect to the DB.`);
    return;
  });

  await connection.beginTransaction().catch(e => {
    console.log(e);
    res.status(400).send(`Unable to start a transaction.`);
    dbpool.releaseConnection(connection);
    return;
  });

  const q_session = "INSERT INTO `sessions`(`experiment_id`, `name`, `start_date`) VALUES (?, ?, CURRENT_TIMESTAMP);"
  const values_session = [experiment_id, session_name]

  const [rows_session, field_sesion] = await dbpool.query(q_session, values_session).catch(async e => {
    console.log(e);
    await connection.rollback();
    dbpool.releaseConnection(connection);
    res.status(400).send(`Failed to start a new session.`);
    return;
  });

  const session_id = rows_session.insertId;

  let trials = [];
  const q_trial = "INSERT INTO `trials`(`session_id`, `block_id`, `trial_idx`, `stimulus`, `expected`,`distractors`) VALUES (?, ?, ?, ?, ?, ?);"
  for (let block_idx = 0; block_idx < blocks.length; block_idx++) {
    let block = blocks[block_idx];
    for (let trial_idx = 1; trial_idx <= block.n_trials; trial_idx++) {
      let stimulus, expected;
      switch (block.type) {
        case 0: {
          // Relation
          const r_idx = Math.floor(Math.random() * rel.length);
          stimulus = rel[r_idx].l;
          expected = rel[r_idx].r
          break;
        }
        case 1: {
          // "Reflexive"
          stimulus = expected = pool[Math.floor(Math.random() * pool.length)];
          break;
        }
        case 2: {
          // symmetric
          const r_idx = Math.floor(Math.random() * rel.length);
          stimulus = rel[r_idx].r;
          expected = rel[r_idx].l;
          break;
        }
        case 3: {
          // transitive
          // console.log("transitive")
          const r_idx = Math.floor(Math.random() * rel.length);
          // console.log(rel)
          // console.log(r_idx)
          // console.log(rel[r_idx])
          // console.log(relMap)
          // console.log(relMap[rel[r_idx]])
          const y = relMap[rel[r_idx].l];
          const step_idx = Math.floor(Math.random() * y.length);
          stimulus = rel[r_idx].r;
          expected = y[step_idx];
          break;
        }
      }
      const distractors = getRandom(pool, block.n_dist, [expected]);
      const values_trial = [session_id, block.block_id, trial_idx, stimulus, expected, JSON.stringify(distractors)];
      const [rows_trial, q_fields_trial] = await dbpool.query(q_trial, values_trial).catch(async e => {
        console.log(e);
        await connection.rollback();
        dbpool.releaseConnection(connection);
        res.status(400).send(`Fail to create the trial.`);
        return;
      });
      trials.push({ trial_id: rows_trial.insertId, session_id: session_id, block_id: blocks[block_idx].block_id, trial_idx: trial_idx, stimulus: stimulus, expected: expected, distractors: distractors });
    }
  }
  res.status(201).json({ "session_id": session_id, blocks: blocks, "trials": trials });
});

app.post("/session/:sessionId", upload.none(), async (req, res) => {
  console.log(`POST /session/${req.params.sessionId} Finishing a session`);
  const q = "UPDATE `sessions` SET `end_date`=CURRENT_TIMESTAMP,`accuracy`=? WHERE session_id = ?;"
  const values = [req.body.acc, req.params.sessionId]

  const [rows, fields] = await dbpool.query(q, values).catch(e => {
    console.log(e);
    res.status(400).send(`Failed to finish session.`);
    return;
  });

  if (rows.changedRows != 1) {
    res.status(400).send(`Failed to finish session.`);
    return;
  }
  res.sendStatus(200);
});

// Block

app.get("/block/:experimentId", upload.none(), async (req, res) => {
  console.log(`GET /block/${req.params.experimentId} Get blocks by experiment id`);
  const q = `SELECT * FROM blocks WHERE experiment_id = ?;`
  const values = [req.params.experimentId]

  const [rows, fields] = await dbpool.query(q, values).catch(e => {
    console.log(e);
    res.status(400).send(`Failed to get blocks.`);
    return;
  });
  res.json(rows);
});

// Relation

app.get("/relation/:experimentId", upload.none(), async (req, res) => {
  console.log(`GET /relation/${req.params.experimentId} Get relation by experiment id`);
  const q = `SELECT * FROM relations WHERE experiment_id = ?;`
  const values = [req.params.experimentId]

  const [rows, fields] = await dbpool.query(q, values).catch(e => {
    console.log(e);
    res.status(400).send(`Failed to get relation.`);
    return;
  });

  res.json(rows);
});

// Response
app.get("/response/:session_id", upload.none(), async (req, res) => {
  console.log(`GET /response/ Get responses`);
  const session_id = parseInt(req.params.session_id);
  if (session_id.isNaN()) {
    res.status(400).json(`Invalid session_id.`);
  }

  const q = `SELECT * FROM sessions
INNER JOIN experiments
	ON experiments.experiment_id = sessions.experiment_id 
INNER JOIN blocks
	ON blocks.experiment_id = experiments.experiment_id
INNER JOIN trials
	ON trials.session_id = sessions.session_id
INNER JOIN responses
	on responses.trial_id = trials.trial_id
WHERE sessions.session_id = ?;`
  const values = [session_id]

  const [rows, fields] = await dbpool.query(q, values).catch(e => {
    console.log(e);
    res.status(400).send({ message: `Fail to obtain responses. ${e}` });
    return;
  });
  res.json(rows);
});

app.post("/response", upload.none(), async (req, res) => {
  console.log(`POST /response Submitting response`);

  const response_time = parseInt(req.body.response_time);
    if (Number.isNaN(response_time)) {
      res.status(400).send(`Invalid response time`);
      return;
    }

  const q = "INSERT INTO `responses`(`submitted_at`, `trial_id`, `response_time`, `choice`, `is_correct`) VALUES (?, ?, ?, ?, ?);"
  const values = [req.body.submitted_at.slice(0, 19).replace('T', ' '), req.body.trial_id, req.body.response_time, req.body.choice, req.body.is_correct === "true"]

  const [rows, fields] = await dbpool.query(q, values).catch(e => {
    console.log(e);
    res.status(400).send(`Failed to create the trial.`);
    return;
  });
  res.status(201).json({ "response_id": rows.insertId });
});

const server = app.listen(port, () => console.log(`Example app listening on port ${port}!`));

server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 5 * 1000;
server.requestTimeout = 10 * 1000;