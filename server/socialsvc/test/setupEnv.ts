// Per-worker setup: bridge the URI globalSetup produced in the main process into this worker's
// process.env, before any test module reads NW_MONGO_URI at module load.
import { bridgeMongoUri } from '../../scripts/testMongoUri';

bridgeMongoUri('socialsvc', 'NW_SOCIAL_MONGO_URI');
