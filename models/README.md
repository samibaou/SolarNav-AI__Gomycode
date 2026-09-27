# ML models

P2 stores trained models here. The application works without a trained model by falling back to the physical baseline.

Create a local model with:

```bash
python scripts/generate_training_data.py
python scripts/train_model.py
```

Generated `.joblib` files are ignored by Git.
