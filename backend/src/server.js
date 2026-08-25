require('dotenv').config();

const express = require('express');
const cors = require('cors');
const clinicRoutes = require('./routes/clinics');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api', clinicRoutes);

app.use(errorHandler);

app.listen(port, () => {
  console.log(`QueueLite backend listening on port ${port}`);
});
