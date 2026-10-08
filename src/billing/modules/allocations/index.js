'use strict';

module.exports = {
  ...require('./domain'),
  ...require('./service'),
  ...require('./repositories/mysqlAllocationRepository'),
};
