import logging
import asyncio
from app.core.db import db

class DBLogHandler(logging.Handler):
    def emit(self, record):
        try:
            msg = self.format(record)
            level = record.levelname
            source = record.name
            
            # Avoid logging logging errors or circular DB logs
            if "app.core.db" in source:
                return
                
            # We want to run db.add_log but we are likely in a synchronous call stack
            # db methods are synchronous (sqlite), so it's fine.
            # But we should be careful about performance. 
            # Ideally logs should be batched or put in a queue. 
            # For this simple app, direct insert is acceptable.
            
            db.add_log(level, msg, source)
        except Exception:
            self.handleError(record)

def setup_logging():
    # Get root logger of 'app'
    logger = logging.getLogger("app")
    logger.setLevel(logging.INFO)
    
    # Check if handler already added
    for h in logger.handlers:
        if isinstance(h, DBLogHandler):
            return
            
    db_handler = DBLogHandler()
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    db_handler.setFormatter(formatter)
    logger.addHandler(db_handler)
    
    # Also attach to uvicorn if we want server logs?
    # uvicorn logs are 'uvicorn.error' and 'uvicorn.access'
    # For now let's just log app actions.
