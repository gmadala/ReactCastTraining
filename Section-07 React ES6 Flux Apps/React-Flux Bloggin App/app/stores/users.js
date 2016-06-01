import constants from '../constants';
import { extend } from './store';

export default extend({
  init() {
    // when users are fetched from the server
    this.bind(constants.GOT_USERS, this.set);
    // when a single chirp is fetched form server
    this.bind(constants.FOLLOWED, this.updateUser);
    this.bind(constants.UNFOLLOWED, this.updateUser);
  },
  updateUser(data) {
    this.currentUser = data;
  },
  currentUser: window.USER,
});
