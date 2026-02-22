DWG support requires ODAFileConverter (not bundled here due to licensing).
Install it on your server and set the env var:

  ODA_PATH=/path/to/ODAFileConverter

Then the API can convert DWG->DXF during pipeline run.

If ODA_PATH is empty or missing, uploading DWG will still work,
but auto-pipeline will fail with a clear error message.

