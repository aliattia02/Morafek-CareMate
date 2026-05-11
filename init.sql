-- Create all databases gPAS needs
CREATE DATABASE IF NOT EXISTS gpas;
CREATE DATABASE IF NOT EXISTS notification_service;
CREATE DATABASE IF NOT EXISTS gras;

-- Grant gpas_user access from any host
GRANT ALL PRIVILEGES ON gpas.* TO 'gpas_user'@'%' IDENTIFIED BY 'gpas_pass';
GRANT ALL PRIVILEGES ON notification_service.* TO 'gpas_user'@'%' IDENTIFIED BY 'gpas_pass';
GRANT ALL PRIVILEGES ON gras.* TO 'gpas_user'@'%' IDENTIFIED BY 'gpas_pass';
FLUSH PRIVILEGES;