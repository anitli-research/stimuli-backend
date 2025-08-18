drop table responses;
drop table trials;
drop table sessions;
drop table relations;
drop table blocks;
drop table experiments;

CREATE TABLE experiments (
    experiment_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    pool_id VARCHAR(255) NOT NULL,
    feedback BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (name)
);

CREATE INDEX experiments_name ON experiments (name);

CREATE TABLE blocks (
    block_id INT AUTO_INCREMENT PRIMARY KEY,
    block_idx INT NOT NULL,
    experiment_id INT NOT NULL,
    type INT NOT NULL,
    n_trials INT NOT NULL,
    n_dist INT NOT NULL,
    FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id)
);

CREATE TABLE relations (
    relation_id INT AUTO_INCREMENT PRIMARY KEY,
    experiment_id INT NOT NULL,
    l VARCHAR(255) NOT NULL,
    r VARCHAR(255) NOT NULL,
    FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id)
);


CREATE TABLE sessions (
    session_id INT AUTO_INCREMENT PRIMARY KEY,
    experiment_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    start_date TIMESTAMP NOT NULL,
    end_date TIMESTAMP NULL DEFAULT NULL,
    accuracy DOUBLE NULL DEFAULT NULL,
    FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id),
    CONSTRAINT UC_exp_user_name UNIQUE (experiment_id, name)
);

CREATE TABLE trials (
    trial_id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    block_id INT NOT NULL,
    trial_idx INT NOT NULL,
    stimulus VARCHAR(255) NOT NULL,
    expected VARCHAR(255) NOT NULL,
    distractors JSON NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (block_id) REFERENCES blocks(block_id)
);

CREATE TABLE responses (
    response_id INT AUTO_INCREMENT PRIMARY KEY,
    submitted_at TIMESTAMP NOT NULL,
    response_time INT NOT NULL,
    trial_id INT NOT NULL,
    choice VARCHAR(255) NOT NULL,
    is_correct BOOLEAN NOT NULL,
    FOREIGN KEY (trial_id) REFERENCES trials(trial_id)
);