CREATE DATABASE IF NOT EXISTS hardware_platform;
USE hardware_platform;

CREATE TABLE IF NOT EXISTS users (
    user_id   INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email     VARCHAR(120) NOT NULL UNIQUE,
    password  VARCHAR(100) NOT NULL,
    role      ENUM('USER', 'ADMIN') NOT NULL DEFAULT 'USER',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS items (
    item_id     INT AUTO_INCREMENT PRIMARY KEY,
    item_name   VARCHAR(120) NOT NULL,
    description VARCHAR(500) NOT NULL,
    category    VARCHAR(80)  NOT NULL,
    price       DECIMAL(10, 2) NOT NULL,
    quantity    INT NOT NULL DEFAULT 0,
    item_colour VARCHAR(50) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) AUTO_INCREMENT = 1000;

CREATE TABLE IF NOT EXISTS cart (
    cart_id  INT AUTO_INCREMENT PRIMARY KEY,
    user_id  INT NOT NULL,
    item_id  INT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_cart_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_cart_item FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
    transaction_id   INT AUTO_INCREMENT PRIMARY KEY,
    user_id          INT NOT NULL,
    total_amount     DECIMAL(10, 2) NOT NULL,
    transaction_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- seed data
INSERT INTO users (full_name, email, password, role) VALUES
('System Administrator', 'admin@hardware.com', 'admin123', 'ADMIN'),
('Demo User',            'user@hardware.com',  'user123',  'USER');

INSERT INTO items (item_name, description, category, price, quantity, item_colour) VALUES
('Cordless Drill',  '18V cordless drill with two battery packs.',       'Power Tools', 1499.99, 15, 'Blue'),
('Claw Hammer',     'Steel claw hammer with anti-slip grip.',           'Hand Tools',   189.99, 45, 'Steel'),
('Safety Goggles',  'Clear protective goggles for workshop use.',       'Safety',        89.99, 80, 'Clear'),
('Socket Set',      '40-piece metric socket set in storage case.',      'Automotive',   599.99, 22, 'Black');
