import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader
from torchvision import datasets, transforms, models
import os
from pathlib import Path

def train_hallmark_model(data_dir, epochs=20, out_dir="ml/models"):
    transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])
    
    dataset = datasets.ImageFolder(data_dir, transform=transform)
    loader = DataLoader(dataset, batch_size=16, shuffle=True)
    
    # Use a pre-trained ResNet-18 for faster training and better accuracy
    model = models.resnet18(pretrained=True)
    num_ftrs = model.fc.in_features
    model.fc = nn.Linear(num_ftrs, 1) # Sigmoid for binary classification (hallmark vs no_hallmark)
    
    criterion = nn.BCEWithLogitsLoss()
    optimizer = optim.AdamW(model.parameters(), lr=1e-3)
    
    print(f"Training hallmark model on {len(dataset)} samples...")
    for ep in range(1, epochs + 1):
        model.train()
        total_loss = 0.0
        for xb, yb in loader:
            optimizer.zero_grad()
            outputs = model(xb).squeeze()
            loss = criterion(outputs, yb.float())
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        print(f"  epoch {ep:2d}/{epochs} loss={total_loss/len(loader):.4f}")
        
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    out_path = os.path.join(out_dir, "hallmark_detector.onnx")
    model.eval()
    dummy = torch.randn(1, 3, 224, 224)
    torch.onnx.export(
        model, dummy, out_path,
        input_names=["image"], output_names=["hallmark_prob"],
        dynamic_axes={"image": {0: "batch"}},
        opset_version=17
    )
    print(f"Exported hallmark model to {out_path}")

if __name__ == "__main__":
    train_hallmark_model("ml/synthetic/hallmarks", epochs=10)
