"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

var _regenerator = _interopRequireDefault(require("@babel/runtime/regenerator"));

var _asyncToGenerator2 = _interopRequireDefault(require("@babel/runtime/helpers/asyncToGenerator"));

var _client = require("./client");

(0, _asyncToGenerator2["default"])( /*#__PURE__*/_regenerator["default"].mark(function _callee() {
  var username, password, libreClient, data;
  return _regenerator["default"].wrap(function _callee$(_context) {
    while (1) {
      switch (_context.prev = _context.next) {
        case 0:
          username = 'USERNAME';
          password = 'PASSWORD';
          libreClient = (0, _client.LibreLinkUpClient)({
            username: username,
            password: password,
            connectionIdentifier: 'IDENTIFIER'
          });
          _context.next = 5;
          return libreClient.read();

        case 5:
          data = _context.sent;
          console.log(data);

        case 7:
        case "end":
          return _context.stop();
      }
    }
  }, _callee);
}))();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJ1c2VybmFtZSIsInBhc3N3b3JkIiwibGlicmVDbGllbnQiLCJMaWJyZUxpbmtVcENsaWVudCIsImNvbm5lY3Rpb25JZGVudGlmaWVyIiwicmVhZCIsImRhdGEiLCJjb25zb2xlIiwibG9nIl0sInNvdXJjZXMiOlsiLi4vc3JjL2NsaWVudC50ZXN0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IExpYnJlTGlua1VwQ2xpZW50IH0gZnJvbSAnLi9jbGllbnQnO1xuXG4oYXN5bmMgZnVuY3Rpb24gKCkge1xuICBjb25zdCB1c2VybmFtZSA9ICdVU0VSTkFNRSc7XG4gIGNvbnN0IHBhc3N3b3JkID0gJ1BBU1NXT1JEJztcbiAgY29uc3QgbGlicmVDbGllbnQgPSBMaWJyZUxpbmtVcENsaWVudCh7XG4gICAgdXNlcm5hbWUsXG4gICAgcGFzc3dvcmQsXG4gICAgY29ubmVjdGlvbklkZW50aWZpZXI6ICdJREVOVElGSUVSJyxcbiAgfSk7XG5cbiAgY29uc3QgZGF0YSA9IGF3YWl0IGxpYnJlQ2xpZW50LnJlYWQoKTtcbiAgY29uc29sZS5sb2coZGF0YSk7XG59KSgpO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7OztBQUFBOztBQUVBLDhFQUFDO0VBQUE7RUFBQTtJQUFBO01BQUE7UUFBQTtVQUNPQSxRQURQLEdBQ2tCLFVBRGxCO1VBRU9DLFFBRlAsR0FFa0IsVUFGbEI7VUFHT0MsV0FIUCxHQUdxQixJQUFBQyx5QkFBQSxFQUFrQjtZQUNwQ0gsUUFBUSxFQUFSQSxRQURvQztZQUVwQ0MsUUFBUSxFQUFSQSxRQUZvQztZQUdwQ0csb0JBQW9CLEVBQUU7VUFIYyxDQUFsQixDQUhyQjtVQUFBO1VBQUEsT0FTb0JGLFdBQVcsQ0FBQ0csSUFBWixFQVRwQjs7UUFBQTtVQVNPQyxJQVRQO1VBVUNDLE9BQU8sQ0FBQ0MsR0FBUixDQUFZRixJQUFaOztRQVZEO1FBQUE7VUFBQTtNQUFBO0lBQUE7RUFBQTtBQUFBLENBQUQifQ==