CREATE TABLE IF NOT EXISTS `report_run` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `started` DATETIME,
  PRIMARY KEY (`id`),
  KEY `idx_started` (`started`)
) ENGINE=InnoDB;
